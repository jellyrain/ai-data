import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  queryDslSchema,
  userPreferenceInputSchema,
  publishedKnowledgeSchema,
} from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { ConversationService } from "../../src/conversations/conversation-service";
import { SqlAnalysisRunRepository } from "../../src/analysis-runs/sql-analysis-run-repository";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { SqlMemoryEventRepository } from "../../src/memory/sql-memory-event-repository";
import { context } from "../support/api-fixtures";
import { createApiDependencies } from "../support/api-fixtures";
import { PreferenceService } from "../../src/preferences/preference-service";
import { SqlPreferenceRepository } from "../../src/preferences/sql-preference-repository";
import { MemoryAccess } from "../../src/memory/memory-access";
import { MemoryRuntime } from "../../src/memory/memory-runtime";
import { AnalysisTools } from "../../src/runtime/analysis-tools";

describe("SQL Server：记忆事件事务、租约与恢复", () => {
  const name = "ai_data_memory_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let created = false;
  let now = dayjs().valueOf();
  let events: SqlMemoryEventRepository;
  let conversations: ConversationService;
  let runs: AnalysisRunService;
  let preferences: PreferenceService;
  let memory: MemoryRuntime;
  let tools: AnalysisTools;
  beforeAll(async () => {
    const raw = JSON.parse(
      readFileSync(
        process.env.SQLSERVER_TEST_CONFIG ??
          fileURLToPath(new URL("../../config/api.config.json", import.meta.url)),
        "utf8",
      ),
    );
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(
      raw.metadata_sqlserver ?? raw,
    );
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await new SqlAuthRepository(database).ensureBootstrapAdmin({
      userId: context.userId,
      organizationId: context.organizationId,
      organizationCode: "memory",
      organizationName: "记忆测试",
      username: "memory",
      displayName: "记忆测试",
      passwordHash: "test-hash",
    });
    events = new SqlMemoryEventRepository(database, { now: () => now });
    conversations = new ConversationService(new SqlConversationRepository(database));
    runs = new AnalysisRunService({
      repository: new SqlAnalysisRunRepository(database),
      refreshContext: async (value) => value,
      applyPreferenceAnswer: async (ctx, id, approved, key, executor) => {
        await preferences.confirm(ctx, id, approved, key, executor);
      },
      authorization: {
        authorize: async (input) => ({
          request: {
            query: queryDslSchema.parse(input),
            access: {
              user_id: context.userId,
              organization_id: context.organizationId,
              analysis_run_id: "test",
              policy_version: 1,
              expires_at: "2026-09-20 23:59:59",
              output_masks: [],
            },
            signature: "test",
          },
          token: "test",
        }),
      },
      client: { execute: async () => ({ columns: [], rows: [], row_count: 0, truncated: false }) },
    });
    const access = new MemoryAccess({
      database,
      catalog: () => {
        throw new Error("本组测试只验证来源与运行事务");
      },
      authorization: () => ({
        authorize: async () => {
          throw new Error("本组无历史数据读取");
        },
      }),
    });
    preferences = new PreferenceService({
      repository: new SqlPreferenceRepository(database),
      authorize: async () => {},
      validateSource: (ctx, source, executor) => access.source(ctx, source, executor),
    });
    memory = new MemoryRuntime({
      preferences,
      knowledge: {
        listPublished: async () => [],
        getPublished: async () => {
          throw new Error("unused");
        },
        submit: async () => {
          throw new Error("unused");
        },
      },
      access,
      runs,
      now: () => Date.parse("2027-01-01T00:01:00+08:00"),
    });
    const api = createApiDependencies();
    tools = new AnalysisTools({
      runs,
      memory,
      catalog: api.catalog.service,
      metrics: {
        ...api.analysis.metrics,
        query: async () => {
          throw new Error("unused");
        },
      },
      reports: api.analysis.reports,
      refreshContext: async (value) => value,
      listSourceIds: async () => [],
    });
  });
  beforeEach(async () => {
    await database.execute({
      sql: "DELETE FROM dbo.memory_events; DELETE FROM dbo.memory_intents; DELETE FROM dbo.preference_audits; DELETE FROM dbo.preference_sources; DELETE FROM dbo.preference_confirmations; DELETE FROM dbo.preference_operations; DELETE FROM dbo.user_preferences;",
      parameters: [],
    });
    now = dayjs().valueOf() + 1000;
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_memory_test_[a-f0-9]{32}$/.test(name)) throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  async function stage() {
    const conversation = await conversations.create(context, "记忆事件测试");
    const submitted = (await conversations.submitUserMessage(
      context,
      conversation.id,
      "本年销售",
      randomUUID(),
    ))!;
    const runId = submitted.analysisRun.id;
    const lease = await runs.claim(context, runId, "test");
    const intent = {
      type: "query_habit",
      preference: {
        key: "sales-year",
        scope: { source_id: "sales", object_id: "orders" },
        value: {
          type: "query_habit",
          time_range: { type: "relative", period: "this_year", extent: "to_date" },
          filters: [],
          dimensions: [],
        },
        auto_apply: true,
      },
      source: {
        conversation_id: conversation.id,
        analysis_run_id: runId,
        message_id: submitted.message.id,
        evidence_ids: [],
      },
    };
    await runs.remember(context, runId, lease, intent);
    await runs.remember(context, runId, lease, intent);
    return { runId, lease };
  }
  async function enqueue() {
    const result = await stage();
    await runs.complete(context, result.runId, result.lease, "查询完成");
    now = dayjs().valueOf() + 1000;
    return result;
  }
  async function dialogue(text: string) {
    const conversation = await conversations.create(context, "记忆对话");
    const submitted = (await conversations.submitUserMessage(
      context,
      conversation.id,
      text,
      randomUUID(),
    ))!;
    return {
      runId: submitted.analysisRun.id,
      lease: await runs.claim(context, submitted.analysisRun.id, "dialogue"),
    };
  }
  const year = userPreferenceInputSchema.parse({
    key: "period",
    value: { type: "time_range", range: { type: "relative", period: "this_year" } },
  });
  const month = userPreferenceInputSchema.parse({
    key: "period",
    value: { type: "time_range", range: { type: "relative", period: "this_month" } },
  });
  it("按需知识在同一租约中并发合并且去重，取消后拒绝迟到写入", async () => {
    const current = await dialogue("核对正式知识");
    await runs.recordMemoryContext(
      context,
      current.runId,
      current.lease,
      await memory.snapshot(context),
    );
    const rule = (id: string) =>
      publishedKnowledgeSchema.parse({
        knowledge_id: id,
        version: 1,
        organization_id: context.organizationId,
        content: { type: "business_rule", title: id, body: "按已确认口径统计" },
        scope: {},
        owner_id: context.userId,
        published_by: context.userId,
        published_at: "2026-09-27 10:00:00",
        effective_at: "2026-09-27 10:00:00",
        source_candidate_id: id,
      });
    await Promise.all([
      runs.recordKnowledgeContext(context, current.runId, current.lease, [rule("first")]),
      runs.recordKnowledgeContext(context, current.runId, current.lease, [rule("second")]),
    ]);
    await runs.recordKnowledgeContext(context, current.runId, current.lease, [rule("first")]);
    const read = async () => {
      const result = await database.execute({
        sql: "SELECT context_json FROM dbo.analysis_memory_contexts WHERE analysis_run_id=@id AND lease_epoch=@epoch",
        parameters: [
          { name: "id", type: "string", value: current.runId },
          { name: "epoch", type: "integer", value: current.lease.epoch },
        ],
      });
      return JSON.parse(String(result.rows[0]!.context_json))
        .knowledge.map((item: { knowledge_id: string }) => item.knowledge_id)
        .sort();
    };
    expect(await read()).toEqual(["first", "second"]);
    await runs.cancel(context, current.runId);
    await expect(
      runs.recordKnowledgeContext(context, current.runId, current.lease, [rule("late")]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await read()).toEqual(["first", "second"]);
  });
  it("工具首次保存无需确认，同账号新会话读取，其他账号隔离", async () => {
    const first = await dialogue("以后默认按本年统计");
    const result = await tools.execute(
      context,
      first.runId,
      first.lease,
      "save_user_preference",
      year,
      "save",
    );
    expect(result).toMatchObject({ success: true, output: { status: "saved" } });
    await runs.complete(context, first.runId, first.lease, "已记住");
    const second = await dialogue("查询数据");
    await runs.recordMemoryContext(
      context,
      second.runId,
      second.lease,
      await memory.snapshot(context),
    );
    const stored = await database.execute({
      sql: "SELECT context_json FROM dbo.analysis_memory_contexts WHERE analysis_run_id=@id",
      parameters: [{ name: "id", type: "string", value: second.runId }],
    });
    expect(JSON.parse(String(stored.rows[0]!.context_json))).toMatchObject({
      preferences: [
        {
          key: "period",
          version: 1,
          resolved_time_range: { start: "2027-01-01", end: "2027-12-31" },
        },
      ],
    });
    expect(
      await tools.execute(context, second.runId, second.lease, "get_user_preferences", {}, "read"),
    ).toMatchObject({ success: true, output: { preferences: [{ key: "period", version: 1 }] } });
    expect(await preferences.list({ ...context, userId: "other" })).toEqual([]);
    await runs.cancel(context, second.runId);
  });
  it("推断偏好冲突暂停运行，真实澄清回答原子提交，重复回答幂等", async () => {
    await preferences.save(context, { ...year, idempotency_key: "first" }, { origin: "user" });
    const run = await dialogue("查一下本月数据");
    const output = await tools.execute(
      context,
      run.runId,
      run.lease,
      "save_user_preference",
      month,
      "change",
    );
    expect(output).toMatchObject({
      success: true,
      stop: true,
      output: { status: "confirmation_required" },
    });
    const state = await runs.get(context, run.runId);
    expect(state.status).toBe("waiting_clarification");
    expect((await preferences.get(context, "period")).value).toEqual(year.value);
    const answer = {
      clarification_id: state.clarification!.clarification_id,
      idempotency_key: "accept",
      option_id: "approve",
    };
    await runs.answer(context, run.runId, answer);
    await runs.answer(context, run.runId, answer);
    expect(await preferences.get(context, "period")).toMatchObject({
      version: 2,
      value: month.value,
    });
    const resumed = await runs.claim(context, run.runId, "resumed");
    expect(
      await tools.execute(
        context,
        run.runId,
        resumed,
        "save_user_preference",
        month,
        "retry-after-answer",
      ),
    ).toMatchObject({ success: true, output: { status: "saved" } });
    expect((await runs.get(context, run.runId)).status).toBe("running");
  });
  it("明确修改直接生效，取消后的迟到工具写入被运行租约拒绝", async () => {
    await preferences.save(context, { ...year, idempotency_key: "first" }, { origin: "user" });
    const run = await dialogue("以后默认按本月统计");
    expect(
      await tools.execute(context, run.runId, run.lease, "save_user_preference", month, "change"),
    ).toMatchObject({ success: true, output: { status: "saved" } });
    await runs.cancel(context, run.runId);
    await expect(memory.save(context, run.runId, run.lease, year, "late")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await preferences.get(context, "period")).value).toEqual(month.value);
  });
  it("后续对话复用原待确认记录，用户拒绝后待确认清单清空", async () => {
    await preferences.save(context, { ...year, idempotency_key: "original" }, { origin: "user" });
    const proposed = await preferences.save(
      context,
      { ...month, idempotency_key: "proposal" },
      { origin: "tool" },
    );
    if (proposed.status !== "confirmation_required") throw new Error("应有待确认项");
    const run = await dialogue("继续查数");
    await tools.execute(
      context,
      run.runId,
      run.lease,
      "save_user_preference",
      { ...month, confirmation_id: proposed.confirmation.confirmation_id },
      "existing",
    );
    const pending = await runs.get(context, run.runId);
    expect(pending.clarification!.preference_confirmation_id).toBe(
      proposed.confirmation.confirmation_id,
    );
    await runs.answer(context, run.runId, {
      clarification_id: pending.clarification!.clarification_id,
      idempotency_key: "reject-original",
      option_id: "reject",
    });
    expect(await preferences.listPendingConfirmations(context)).toEqual([]);
    expect((await preferences.get(context, "period")).value).toEqual(year.value);
  });
  it("确认期间偏好已变化则原子拒绝，运行仍保持待答状态", async () => {
    await preferences.save(context, { ...year, idempotency_key: "first" }, { origin: "user" });
    const run = await dialogue("查本月");
    await tools.execute(context, run.runId, run.lease, "save_user_preference", month, "change");
    const pending = await runs.get(context, run.runId);
    await preferences.setAutoApply(context, "period", {
      auto_apply: false,
      expected_version: 1,
      idempotency_key: "disable",
    });
    await expect(
      runs.answer(context, run.runId, {
        clarification_id: pending.clarification!.clarification_id,
        idempotency_key: "stale",
        option_id: "approve",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await runs.get(context, run.runId)).status).toBe("waiting_clarification");
    expect(await preferences.get(context, "period")).toMatchObject({
      version: 2,
      auto_apply: false,
    });
  });
  it("同账号跨会话观察两次才应用习惯，停用后重复观察不恢复", async () => {
    for (let i = 0; i < 2; i++) {
      await enqueue();
      const event = (await events.claim("memory", 5000, 3))!;
      await events.complete(event, (executor) => memory.process(context, event, executor));
    }
    expect((await memory.snapshot(context)).preferences).toHaveLength(1);
    const preference = (await preferences.list(context))[0]!;
    expect(preference.use_count).toBe(2);
    await preferences.setAutoApply(context, preference.key, {
      auto_apply: false,
      expected_version: preference.version,
      idempotency_key: "disable",
    });
    await enqueue();
    const event = (await events.claim("memory", 5000, 3))!;
    await events.complete(event, (executor) => memory.process(context, event, executor));
    expect((await memory.snapshot(context)).preferences).toHaveLength(0);
    expect((await preferences.get(context, preference.key)).use_count).toBe(3);
  });
  it("回答成功才入队，重复意图只生成一个事件，取消后不入队", async () => {
    const first = await stage();
    expect(await events.list(context, 20)).toEqual([]);
    await runs.complete(context, first.runId, first.lease, "查询完成");
    expect(await events.list(context, 20)).toHaveLength(1);
    const second = await stage();
    await runs.cancel(context, second.runId);
    expect(await events.list(context, 20)).toHaveLength(1);
  });
  it("两个执行器竞争只有一个领取，过期接管后旧执行器无法提交", async () => {
    await enqueue();
    const claims = await Promise.all([
      events.claim("worker-a", 5000, 3),
      events.claim("worker-b", 5000, 3),
    ]);
    const first = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    now += 6000;
    const second = (await new SqlMemoryEventRepository(database, { now: () => now }).claim(
      "worker-c",
      5000,
      3,
    ))!;
    expect(second.lease_epoch).toBe(first.lease_epoch + 1);
    await expect(events.complete(first, async () => {})).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await events.complete(second, async () => {});
    expect((await events.list(context, 20))[0]).toMatchObject({ status: "done", attempts: 2 });
  });
  it("副作用与完成状态同事务，处理失败回滚后可重试且不重复提交", async () => {
    await enqueue();
    const event = (await events.claim("worker", 5000, 3))!;
    const effectId = randomUUID();
    const insert = {
      sql: "INSERT INTO dbo.preference_audits(audit_id,organization_id,user_id,record_json) VALUES(@id,@org,@user,N'{}')",
      parameters: [
        { name: "id", type: "string" as const, value: effectId },
        { name: "org", type: "string" as const, value: context.organizationId },
        { name: "user", type: "string" as const, value: context.userId },
      ],
    };
    await expect(
      events.complete(event, async (executor) => {
        await executor.execute(insert);
        throw new Error("处理失败");
      }),
    ).rejects.toThrow("处理失败");
    const count = () =>
      database.execute({
        sql: "SELECT COUNT(*) AS count FROM dbo.preference_audits WHERE audit_id=@id",
        parameters: [{ name: "id", type: "string", value: effectId }],
      });
    expect((await count()).rows).toEqual([{ count: 0 }]);
    await events.complete(event, async (executor) => {
      await executor.execute(insert);
    });
    await expect(
      events.complete(event, async (executor) => {
        await executor.execute(insert);
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await count()).rows).toEqual([{ count: 1 }]);
  });
  it("失败按退避重试，达到上限后管理员可重新派发，其他组织不可重试", async () => {
    await enqueue();
    const first = (await events.claim("worker", 5000, 2))!;
    await events.fail(first, "INTERNAL_ERROR", 2, 2000);
    expect(await events.claim("worker", 5000, 2)).toBeNull();
    now += 2001;
    const second = (await events.claim("worker", 5000, 2))!;
    await events.fail(second, "INTERNAL_ERROR", 2, 2000);
    expect((await events.list(context, 20))[0]).toMatchObject({ status: "failed", attempts: 2 });
    await expect(
      events.retry({ ...context, organizationId: "other" }, second.event_id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await events.retry(context, second.event_id);
    expect(await events.claim("worker", 5000, 2)).toMatchObject({ attempts: 1 });
  });
  it("租约可续期，释放可恢复，处理超期或已取消时不提交副作用", async () => {
    await enqueue();
    const first = (await events.claim("worker", 1000, 3))!;
    now += 500;
    await events.renew(first, 5000);
    now += 1000;
    expect(await events.claim("other", 1000, 3)).toBeNull();
    await events.release(first);
    const second = (await events.claim("other", 1000, 3))!;
    const signal = AbortSignal.abort();
    await expect(events.complete(second, async () => {}, signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    now += 2000;
    await expect(events.complete(second, async () => {})).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
