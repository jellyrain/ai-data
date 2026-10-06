import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { queryDslSchema, type QueryEvidence } from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { ConversationService } from "../../src/conversations/conversation-service";
import { SqlAnalysisRunRepository } from "../../src/analysis-runs/sql-analysis-run-repository";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { context } from "../support/api-fixtures";
import type { AuthContext } from "../../src/auth/auth-types";
import { registerBusinessAcceptance } from "./business-acceptance";
import { SqlRuntimeRepository } from "../../src/runtime/sql-runtime-repository";
import { SqlCatalogAdminRepository } from "../../src/catalog-admin/sql-catalog-admin-repository";
import { SqlReportRepository } from "../../src/reports/sql-report-repository";
import { runTime } from "../../src/analysis-runs/run-time";

/** 只复用本地连接信息，每次运行在随机临时数据库中验证实际事务。 */
describe("SQL Server：部门授权与分析运行", () => {
  const name = "ai_data_api_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let created = false;
  let auth: SqlAuthRepository;
  let conversations: ConversationService;
  let repository: SqlAnalysisRunRepository;
  registerBusinessAcceptance(() => database);
  beforeAll(async () => {
    const path =
      process.env.SQLSERVER_TEST_CONFIG ??
      fileURLToPath(new URL("../../config/api.config.json", import.meta.url));
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(
      raw.metadata_sqlserver ?? raw,
    );
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    auth = new SqlAuthRepository(database);
    await auth.ensureBootstrapAdmin({
      userId: context.userId,
      organizationId: context.organizationId,
      organizationCode: "test",
      organizationName: "测试组织",
      username: "test",
      displayName: "测试用户",
      passwordHash: "test-hash",
    });
    conversations = new ConversationService(new SqlConversationRepository(database));
    repository = new SqlAnalysisRunRepository(database);
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_api_test_[a-f0-9]{32}$/.test(name)) throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  async function submit() {
    const conversation = await conversations.create(context, "分析测试");
    const submitted = await conversations.submitUserMessage(
      context,
      conversation.id,
      "查询",
      randomUUID(),
    );
    return { conversation, submitted: submitted! };
  }
  function runService(now: () => number = Date.now) {
    return new AnalysisRunService({
      repository,
      now,
      leaseMilliseconds: 3000,
      refreshContext: async (context: AuthContext) => context,
      authorization: {
        authorize: async (input: unknown) => ({
          request: { query: queryDslSchema.parse(input), access: { output_masks: [] } },
          token: "test",
        }),
      },
      client: { execute: async () => ({ columns: [], rows: [], row_count: 0, truncated: false }) },
    } as unknown as ConstructorParameters<typeof AnalysisRunService>[0]);
  }
  it("流式文字跨仓储恢复连续序号，最终事务失败不发布完成或唤醒", async () => {
    const { submitted } = await submit();
    const id = submitted.analysisRun.id;
    const runs = runService();
    const lease = await runs.claim(context, id, "stream-worker");
    await runs.recordMessage(context, id, lease, {
      itemId: "message",
      status: "started",
      content: "",
    });
    await runs.recordMessage(context, id, lease, {
      itemId: "message",
      status: "delta",
      content: "已查询",
    });
    const persisted = await new SqlAnalysisRunRepository(database).listEvents(context, id, 2);
    expect(persisted).toEqual([
      expect.objectContaining({
        sequence: 3,
        lease_epoch: 1,
        type: "assistant_message",
        message_id: "message",
        content: "已查询",
      }),
    ]);
    let wakes = 0;
    const unsubscribe = runs.subscribeEvents(id, () => {
      wakes++;
    });
    await expect(
      runs.complete(
        context,
        id,
        lease,
        "完成",
        async () => {
          throw new Error("提交失败");
        },
        "message",
      ),
    ).rejects.toThrow("提交失败");
    expect(wakes).toBe(0);
    expect((await runs.get(context, id)).status).toBe("running");
    expect(await runs.events(context, id, 3)).toEqual([]);
    await runs.complete(context, id, lease, "完成", undefined, "message");
    expect((await runs.events(context, id, 3)).map((event) => event.type)).toEqual([
      "final_answer",
      "run_completed",
    ]);
    expect(wakes).toBe(1);
    unsubscribe();
  });
  it("官方会话映射跨仓储实例恢复，授权或工具版本变化时重建上下文", async () => {
    const { submitted } = await submit();
    const id = submitted.analysisRun.id;
    const lease = await runService().claim(context, id, "codex-worker");
    const runtime = new SqlRuntimeRepository(database);
    const input = await runtime.loadInput(context, id, "tools-v1");
    await runtime.saveThread(context, id, lease, input.context_hash, "official-thread");
    expect(
      (await new SqlRuntimeRepository(database).loadInput(context, id, "tools-v1")).thread_id,
    ).toBe("official-thread");
    expect((await runtime.loadInput(context, id, "tools-v2")).thread_id).toBeUndefined();
    expect(
      (
        await runtime.loadInput(
          { ...context, permissionContext: { department_ids: ["changed"] } },
          id,
          "tools-v1",
        )
      ).thread_id,
    ).toBeUndefined();
    await expect(runtime.loadInput({ ...context, userId: "other" }, id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("失效租约不能覆盖官方会话映射", async () => {
    const { submitted } = await submit();
    const id = submitted.analysisRun.id;
    const runs = runService();
    const lease = await runs.claim(context, id, "codex-owner");
    const runtime = new SqlRuntimeRepository(database);
    const input = await runtime.loadInput(context, id);
    await runtime.saveThread(context, id, lease, input.context_hash, "current-thread");
    await expect(
      runtime.saveThread(
        context,
        id,
        { ...lease, epoch: lease.epoch + 1 },
        input.context_hash,
        "stale-thread",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await runs.complete(context, id, lease, "完成");
    await expect(
      runtime.saveThread(context, id, lease, input.context_hash, "late-thread"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await runtime.loadInput(context, id)).thread_id).toBe("current-thread");
  });
  it("用户消息和后台派发引用一起提交，重试返回同一队列记录", async () => {
    const service = new ConversationService(new SqlConversationRepository(database), {
      dispatcher: { wake() {} },
      authorizeRun: async () => {},
    });
    const conversation = await service.create(context);
    const first = await service.submitUserMessage(context, conversation.id, "本月人数", "dispatch");
    const repeated = await service.submitUserMessage(
      context,
      conversation.id,
      "本月人数",
      "dispatch",
    );
    expect(repeated!.analysisRun.id).toBe(first!.analysisRun.id);
    const pending = await new SqlRuntimeRepository(database).pending(100);
    expect(pending.filter((task) => task.runId === first!.analysisRun.id)).toEqual([
      {
        runId: first!.analysisRun.id,
        userId: context.userId,
        organizationId: context.organizationId,
        sessionId: context.sessionId,
      },
    ]);
  });
  it("澄清、回答及最终助手消息保存在原会话，序号连续且可恢复", async () => {
    const { submitted, conversation } = await submit();
    const runs = runService();
    const id = submitted.analysisRun.id;
    const lease = await runs.claim(context, id, "worker");
    await runs.clarify(context, id, lease, {
      clarification_id: "date",
      question: "统计日期？",
      options: [{ id: "visit", label: "就诊日期" }],
      allow_custom_input: false,
    });
    await runs.answer(context, id, {
      clarification_id: "date",
      option_id: "visit",
      idempotency_key: "reply",
    });
    await runs.complete(context, id, await runs.claim(context, id, "next"), "按就诊日期统计完成");
    const detail = (await conversations.get(context, conversation.id))!;
    expect(detail.messages.map((message) => message.sequence)).toEqual([0, 1, 2, 3]);
    expect(detail.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(detail.messages.every((message) => message.analysisRunId === id)).toBe(true);
    expect(
      (await new SqlRuntimeRepository(database).loadInput(context, id)).messages.at(-1)?.content,
    ).toBe("按就诊日期统计完成");
  });
  it("策略内容和版本原子更新，竞争版本仅一个写入成功", async () => {
    const repository = new SqlCatalogAdminRepository(database);
    const roleId = (await auth.loadAuthorization(context.userId)).roleIds![0];
    const save = (object: string, version: number) =>
      repository.saveChange(
        context,
        "versioned-source",
        {
          kind: "object_permission",
          permission: { role_id: roleId, object_id: object, effect: "allow" },
        },
        version,
      );
    const first = await save("visits", 0);
    expect(first.version).toBe(1);
    const results = await Promise.allSettled([save("orders", 1), save("departments", 1)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (await repository.listVersions(context.organizationId, "versioned-source", roleId, 20)).map(
        (item) => item.version,
      ),
    ).toEqual([2, 1]);
    expect(await repository.currentPolicyVersion(context, "versioned-source")).toBe(2);
    expect(await repository.loadRoleAuthorization("other-org", roleId)).toBeNull();
  });
  it("报告工具重复保存只产生一个快照，取消后的租约不能保存报告", async () => {
    const { submitted } = await submit();
    const id = submitted.analysisRun.id;
    const runs = runService();
    const lease = await runs.claim(context, id, "report-worker");
    const evidence = await runs.query(context, id, lease, "report-query", {
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visits", alias: "v" },
      select: [{ field: "v.id", as: "id" }],
    });
    const snapshot = {
      analysis_run_id: id,
      title: "报告",
      sections: [
        {
          section_id: "s",
          title: "结果",
          blocks: [
            {
              block_id: "b",
              type: "table" as const,
              title: "查询结果",
              evidence_ids: [evidence.evidence_id],
            },
          ],
        },
      ],
      shared_with: [],
      sources: [evidence],
      organization_id: context.organizationId,
      user_id: context.userId,
      created_at: runTime(),
    };
    const repository = new SqlReportRepository(database);
    const report = await repository.save(context, snapshot, undefined, undefined, {
      lease,
      key: "same",
    });
    const repeated = await repository.save(
      context,
      { ...snapshot, created_at: "2026-09-14 22:00:00" },
      undefined,
      undefined,
      { lease, key: "same" },
    );
    expect(repeated.report_id).toBe(report.report_id);
    expect(repeated.version).toBe(1);
    await runs.cancel(context, id);
    await expect(
      repository.save(context, snapshot, undefined, undefined, { lease, key: "late" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("部门替换与授权版本一起提交，跨组织修改不生效", async () => {
    const before = await auth.findUserById(context.userId);
    await expect(
      auth.updateUserDepartments(context.userId, context.organizationId, ["A", "B"]),
    ).resolves.toBe(true);
    expect((await auth.loadAuthorization(context.userId)).permissionContext).toEqual({
      department_ids: ["A", "B"],
    });
    expect((await auth.findUserById(context.userId))!.authorizationVersion).toBe(
      before!.authorizationVersion + 1,
    );
    await expect(auth.updateUserDepartments(context.userId, "other", ["C"])).resolves.toBe(false);
    expect((await auth.loadAuthorization(context.userId)).permissionContext).toEqual({
      department_ids: ["A", "B"],
    });
    await auth.updateUserDepartments(context.userId, context.organizationId, []);
    expect((await auth.loadAuthorization(context.userId)).permissionContext).toEqual({
      department_ids: [],
    });
  });
  it("并发重复提交只产生一条消息和一个运行", async () => {
    const conversation = await conversations.create(context);
    const input = () => conversations.submitUserMessage(context, conversation.id, "查询", "same");
    const [first, second] = await Promise.all([input(), input()]);
    expect(first!.message.id).toBe(second!.message.id);
    expect(first!.analysisRun.id).toBe(second!.analysisRun.id);
    expect((await conversations.get(context, conversation.id))!.messages).toHaveLength(1);
    await expect(
      conversations.submitUserMessage(context, conversation.id, "其他问题", "same"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("同会话竞争仅接受一个新运行，不同会话并行", async () => {
    const conversation = await conversations.create(context);
    const actions = await Promise.allSettled(
      ["first", "second"].map((key) =>
        conversations.submitUserMessage(context, conversation.id, key, key),
      ),
    );
    expect(actions.filter((action) => action.status === "fulfilled")).toHaveLength(1);
    const other = await conversations.create(context);
    expect(
      await conversations.submitUserMessage(context, other.id, "第三个问题", "third"),
    ).not.toBeNull();
  });
  it("运行写入失败时消息一起回滚", async () => {
    const conversation = await conversations.create(context);
    const failing = new SqlConversationRepository({
      execute: database.execute.bind(database),
      transaction: (action) =>
        database.transaction((executor) =>
          action({
            execute: (statement) => {
              if (statement.sql.startsWith("INSERT INTO dbo.analysis_runs"))
                throw new Error("模拟运行写入失败");
              return executor.execute(statement);
            },
          }),
        ),
    });
    await expect(
      failing.submitMessage(
        conversation.id,
        context.userId,
        context.organizationId,
        "查询",
        "failure",
      ),
    ).rejects.toThrow("模拟运行写入失败");
    expect((await conversations.get(context, conversation.id))!.messages).toHaveLength(0);
    expect(
      await conversations.submitUserMessage(context, conversation.id, "查询", "failure"),
    ).not.toBeNull();
  });
  it("跨用户读取运行与回放事件被拒绝", async () => {
    const { submitted } = await submit();
    await expect(
      repository.get({ ...context, userId: "other" }, submitted.analysisRun.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repository.listEvents({ ...context, userId: "other" }, submitted.analysisRun.id, 0),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("重建服务后恢复租约与澄清，旧执行代次不能提交", async () => {
    let clock = Date.parse("2026-09-14T00:00:00Z");
    const { submitted } = await submit();
    const id = submitted.analysisRun.id;
    const first = runService(() => clock);
    const lease = await first.claim(context, id, "first");
    clock += 4000;
    const recovered = runService(() => clock);
    const next = await recovered.claim(context, id, "next");
    expect(next.epoch).toBe(lease.epoch + 1);
    await expect(first.complete(context, id, lease, "late")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await recovered.clarify(context, id, next, {
      clarification_id: "q",
      question: "请选择",
      options: [{ id: "a", label: "A" }],
      allow_custom_input: false,
    });
    const resumed = runService(() => clock);
    expect((await resumed.get(context, id)).clarification?.clarification_id).toBe("q");
    const answer = { clarification_id: "q", option_id: "a", idempotency_key: "answer" };
    await resumed.answer(context, id, answer);
    await resumed.answer(context, id, answer);
    const events = await resumed.events(context, id, 0);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.filter((event) => event.type === "clarification_answered")).toHaveLength(1);
  });
  it("证据校验失败时状态和已经插入的事件全部回滚", async () => {
    const { submitted } = await submit();
    const id = submitted.analysisRun.id;
    await expect(
      repository.change(context, id, () => ({
        events: [{ type: "progress", message: "正在查询" }],
        evidence: [{} as QueryEvidence],
      })),
    ).rejects.toThrow();
    expect((await repository.get(context, id)).sequence).toBe(0);
    expect(await repository.listEvents(context, id, 0)).toEqual([]);
  });
});
