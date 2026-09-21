import { generateKeyPairSync, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import dayjs from "dayjs";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { queryDslSchema, type QueryResult } from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { AuthService } from "../../src/auth/auth-service";
import { JwtService } from "../../src/auth/jwt-service";
import type { AuthContext } from "../../src/auth/auth-types";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { ConversationService } from "../../src/conversations/conversation-service";
import { SqlAnalysisRunRepository } from "../../src/analysis-runs/sql-analysis-run-repository";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { SqlCatalogRepository } from "../../src/catalog/sql-catalog-repository";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { DataAccessQueryClient } from "../../src/data-access/data-access-query-client";
import { MetricService } from "../../src/metrics/metric-service";
import { SqlMetricRepository } from "../../src/metrics/sql-metric-repository";
import { ReportService } from "../../src/reports/report-service";
import { SqlReportRepository } from "../../src/reports/sql-report-repository";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { AnalysisExecutor } from "../../src/runtime/analysis-executor";
import { SqlRuntimeRepository } from "../../src/runtime/sql-runtime-repository";
import type { AnalysisHarness, HarnessRequest } from "../../src/harness/harness-types";
import { registerConversationRoutes } from "../../src/routes/conversation-routes";
import { registerAnalysisRoutes } from "../../src/routes/analysis-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { config } from "../support/api-fixtures";
import { DialogueDasFixture, readDialogueConnection } from "./dialogue-das-fixture";
import { configuredDialogueHarness, readConfiguredDialogueRuntime } from "./dialogue-model-fixture";
import { createAgentConfiguration } from "../../src/agents/create-agent-configuration";
import type { ExecutorDependencies } from "../../src/runtime/runtime-types";
import { SkillResources } from "../../src/skills/skill-resources";

// 普通 SQL 验收不会连接模型配置库；只有显式启用真实模型专项时读取已发布版本。
const configuredModel =
  process.env.LOCAL_MODEL_ACCEPTANCE === "1" ? await readConfiguredDialogueRuntime() : undefined;

/** 两个科室共享一条就诊号，分科计数与全量去重的结果分别为 2+2 和 3。 */
const groupedQuery = queryDslSchema.parse({
  type: "relational_query",
  source_id: "dialogue",
  from: { object_id: "table.dbo.dialogue_visits", alias: "v" },
  select: [
    { field: "v.department", as: "department" },
    { field: "v.visit_id", aggregation: "count_distinct", as: "visits" },
  ],
  filters: {
    logic: "and",
    items: [
      {
        field: "v.visited_on",
        op: "between",
        data_type: "date",
        value: ["2026-09-01", "2026-09-30"],
      },
    ],
  },
  group_by: ["v.department"],
  order_by: [{ field: "v.department", direction: "asc" }],
});
const totalQuery = queryDslSchema.parse({
  ...groupedQuery,
  select: [{ field: "v.visit_id", aggregation: "count_distinct", as: "visits" }],
  group_by: [],
  order_by: [],
});

/** 本轮数据库和身份的验收引用；令牌只用于本机 API 请求。 */
type Identity = { context: AuthContext; token: string };
/** 每轮创建的数据库在连接失败时仍记录名称，便于清理已执行的 CREATE。 */
type CreatedDatabase = { name: string; database?: SqlServerMetadataDatabase };

describe("自然语言分析：API、DAS HTTP 与 SQL Server 对话验收", () => {
  const prefix = "ai_data_dialogue_test_" + randomUUID().replaceAll("-", "");
  const created: CreatedDatabase[] = [];
  const executors: AnalysisExecutor[] = [];
  const das = new DialogueDasFixture();
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let auditDatabase: SqlServerMetadataDatabase;
  let app: FastifyInstance;
  let runs: AnalysisRunService;
  let tools: AnalysisTools;
  let toolDependencies: ConstructorParameters<typeof AnalysisTools>[0];
  let repository: SqlRuntimeRepository;
  let auth: AuthService;
  let full: Identity;
  let restricted: Identity;
  let modelStateDirectory: string | undefined;
  const skills = new SkillResources(
    fileURLToPath(new URL("../../../../packages/skills/", import.meta.url)),
  );
  const models: ReturnType<typeof configuredDialogueHarness>[] = [];

  beforeAll(async () => {
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(readDialogueConnection());
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    for (const suffix of ["api", "das"]) {
      const name = prefix + "_" + suffix;
      await admin.execute({ sql: "CREATE DATABASE " + identifier(name), parameters: [] });
      const entry: CreatedDatabase = { name };
      created.push(entry);
      entry.database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    }
    database = created[0].database!;
    auditDatabase = created[1].database!;
    await auditDatabase.execute({
      sql: `CREATE TABLE dbo.dialogue_visits (visit_id INT NOT NULL, department NVARCHAR(8) NOT NULL, visited_on DATE NOT NULL);
        INSERT INTO dbo.dialogue_visits VALUES (1,'A','2026-09-10'),(2,'A','2026-09-10'),(2,'B','2026-09-10'),(3,'B','2026-09-10'),(9,'A','2026-08-30');`,
      parameters: [],
    });
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const jwt = await JwtService.create({
      ...config,
      jwt: {
        ...config.jwt,
        signing_private_key_pem: keys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        verification_public_key_pem: publicKey,
      },
    });
    await das.start({ ...connection, database: created[1].name }, publicKey);
    const catalogClient = await das.expose({ ...connection, database: created[1].name }, jwt);
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    const catalogRepository = new SqlCatalogRepository(database);
    const catalog = new BusinessCatalogService(
      {
        listRawCatalog: (sourceId) =>
          catalogClient.listCatalog(das.serviceUrl, sourceId, das.serviceId),
      },
      catalogRepository,
      catalogRepository,
    );
    const authRepository = new SqlAuthRepository(database);
    await authRepository.ensureBootstrapAdmin({
      userId: "dialogue-admin",
      organizationId: "dialogue-org",
      organizationCode: "dialogue",
      organizationName: "对话验收组织",
      username: "dialogue-admin",
      displayName: "验收管理员",
      passwordHash: "fixture-hash",
    });
    await database.execute({
      sql: `
      INSERT INTO dbo.roles(id,code,name) VALUES ('dialogue-full','dialogue-full',N'双科室'),('dialogue-a','dialogue-a',N'A 科室');
      INSERT INTO dbo.users(id,organization_id,username,display_name,status) VALUES
        ('dialogue-full','dialogue-org','dialogue-full',N'双科室用户','active'),('dialogue-a','dialogue-org','dialogue-a',N'A 科室用户','active');
      INSERT INTO dbo.user_roles VALUES ('dialogue-full','dialogue-full'),('dialogue-a','dialogue-a');`,
      parameters: [],
    });
    auth = new AuthService({ repository: authRepository, jwt });
    for (const role of ["dialogue-full", "dialogue-a"]) {
      await catalogRepository.saveObjectPermission("dialogue", {
        role_id: role,
        object_id: groupedQuery.from.object_id,
        effect: "allow",
      });
      await catalogRepository.saveRowPolicy("dialogue", {
        role_id: role,
        object_id: groupedQuery.from.object_id,
        effect: "allow",
        condition: {
          field: "department",
          op: "in",
          value_from: "permission_context.department_ids",
        },
      });
      await authRepository.updateUserDepartments(
        role,
        "dialogue-org",
        role === "dialogue-full" ? ["A", "B"] : ["A"],
      );
      const sessionId = randomUUID();
      await authRepository.createSession({
        id: sessionId,
        userId: role,
        refreshTokenHash: randomUUID(),
        expiresAt: dayjs().add(1, "hour").toDate(),
        revokedAt: null,
      });
      const user = await authRepository.findUserById(role);
      const token = await jwt.signAccessToken({
        userId: role,
        organizationId: "dialogue-org",
        sessionId,
        authorizationVersion: user!.authorizationVersion,
      });
      const identity = { token, context: await auth.loadContext(token) };
      if (role === "dialogue-full") full = identity;
      else restricted = identity;
    }
    const authorization = new QueryAuthorizationService(catalog, jwt);
    const client = new DataAccessQueryClient({
      listHealthyServices: async () => [
        {
          serviceId: das.serviceId,
          serviceUrl: das.serviceUrl,
          serviceVersion: "integration",
          status: "healthy",
          lastHeartbeatAt: dayjs().toDate(),
          message: null,
          sources: [
            {
              source_id: "dialogue",
              status: "healthy",
              checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
            },
          ],
        },
      ],
    });
    const refreshContext = auth.refreshContext.bind(auth);
    runs = new AnalysisRunService({
      repository: new SqlAnalysisRunRepository(database),
      authorization,
      client,
      refreshContext,
    });
    toolDependencies = {
      skills,
      runs,
      catalog,
      refreshContext,
      listSourceIds: async () => ["dialogue"],
      metrics: new MetricService(new SqlMetricRepository(database), authorization, runs),
      reports: new ReportService(new SqlReportRepository(database), runs, authorization),
    };
    tools = new AnalysisTools(toolDependencies);
    repository = new SqlRuntimeRepository(database);
    app = Fastify({ logger: false });
    registerContractErrorHandler(app);
    registerConversationRoutes(
      app,
      auth,
      new ConversationService(new SqlConversationRepository(database)),
    );
    registerAnalysisRoutes(app, auth, runs);
    await app.ready();
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const action of [
      () => Promise.all(executors.map((executor) => executor.close())),
      () => Promise.all(models.map((model) => model.close())),
      () => app?.close(),
      () => das.close(),
      () => {
        if (!modelStateDirectory) return Promise.resolve();
        if (dirname(modelStateDirectory) !== resolve("secrets"))
          throw new Error("模型测试目录超出项目范围");
        return rm(modelStateDirectory, { recursive: true, force: true });
      },
    ]) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const entry of created) {
      try {
        await entry.database?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await admin.execute({ sql: "DROP DATABASE " + identifier(entry.name), parameters: [] });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await admin?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "对话验收资源清理失败");
  });

  /** SQL 标识符只能使用本轮随机前缀和两个固定用途。 */
  function identifier(name: string): string {
    if (
      !/^ai_data_dialogue_test_[a-f0-9]{32}_(api|das)$/.test(name) ||
      !name.startsWith(prefix + "_")
    )
      throw new Error("对话验收数据库名称无效");
    return `[${name}]`;
  }

  function executor(
    harness: AnalysisHarness,
    instructions = "根据业务目录和证据分析就诊人次。",
    resolveConfiguration?: ExecutorDependencies["resolveConfiguration"],
  ): AnalysisExecutor {
    const instance = new AnalysisExecutor({
      runs,
      tools,
      repository,
      harness,
      refreshContext: auth.refreshContext.bind(auth),
      instructions,
      resolveConfiguration,
    });
    executors.push(instance);
    return instance;
  }

  async function submit(identity: Identity, content: string, conversationId?: string) {
    const headers = { authorization: `Bearer ${identity.token}` };
    if (!conversationId) {
      const created = await app.inject({
        method: "POST",
        url: "/conversations",
        headers,
        payload: { title: "就诊分析" },
      });
      expect(created.statusCode).toBe(201);
      conversationId = created.json<{ id: string }>().id;
    }
    const payload = { content, idempotency_key: randomUUID() };
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(201);
    const repeated = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/messages`,
      headers,
      payload,
    });
    expect(repeated.json()).toEqual(response.json());
    return {
      conversationId,
      runId: response.json<{ analysisRun: { id: string } }>().analysisRun.id,
    };
  }

  async function queryAudit(runId: string) {
    return (
      await auditDatabase.execute({
        sql: "SELECT analysis_run_id,user_id,organization_id,source_id,outcome,row_count,row_filter_injected FROM dbo.query_audit_logs WHERE analysis_run_id=@run ORDER BY audit_id",
        parameters: [{ name: "run", type: "string", value: runId }],
      })
    ).rows;
  }

  /** 固定脚本验证模型工具边界；执行器和每次查询均使用真实业务服务。 */
  async function dialogue(identity: Identity) {
    const submitted = await submit(identity, "分析九月各科室就诊人次和总人次");
    let phase = 0;
    const inputs: string[] = [];
    const observed: QueryResult[] = [];
    const harness: AnalysisHarness = {
      run: vi.fn(async (request: HarnessRequest) => {
        inputs.push(request.input);
        if (phase++ === 0) {
          expect(
            (
              await request.executeTool(
                "search_catalog",
                { source_id: "dialogue", query: "dialogue_visits", limit: 10 },
                "catalog",
              )
            ).success,
          ).toBe(true);
          expect(
            (
              await request.executeTool(
                "describe_dataset",
                { source_id: "dialogue", object_id: groupedQuery.from.object_id },
                "describe",
              )
            ).success,
          ).toBe(true);
          const clarification = await request.executeTool(
            "request_clarification",
            {
              question: "请选择就诊统计月份",
              options: [{ id: "september", label: "2026 年 9 月" }],
              allow_custom_input: false,
            },
            "clarify",
          );
          expect(clarification).toMatchObject({ success: true, stop: true });
          return { status: "waiting_clarification" as const };
        }
        expect(request.input).toContain("2026 年 9 月");
        for (const [index, query] of [groupedQuery, totalQuery].entries()) {
          const result = await request.executeTool("query_dataset", { query }, `query-${index}`);
          expect(result.success).toBe(true);
          observed.push(result.output as QueryResult);
          expect((await runs.get(identity.context, submitted.runId)).status).toBe("running");
          expect(await request.executeTool("query_dataset", { query }, `query-${index}`)).toEqual(
            result,
          );
        }
        return {
          status: "completed" as const,
          content: `九月就诊总人次为 ${String(observed[1].rows[0].visits)}，科室结果已保存。`,
        };
      }),
    };
    const runtime = executor(harness);
    await runtime.execute(identity.context, submitted.runId);
    const waiting = await runs.get(identity.context, submitted.runId);
    expect(waiting.status).toBe("waiting_clarification");
    expect(await runs.evidence(identity.context, submitted.runId)).toEqual([]);
    const answer = {
      clarification_id: waiting.clarification!.clarification_id,
      option_id: "september",
      idempotency_key: "answer-september",
    };
    const headers = { authorization: `Bearer ${identity.token}` };
    for (let retry = 0; retry < 2; retry++) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/analysis-runs/${submitted.runId}/answers`,
            headers,
            payload: answer,
          })
        ).statusCode,
      ).toBe(200);
    }
    await runtime.execute(identity.context, submitted.runId);
    const state = await runs.get(identity.context, submitted.runId);
    expect(state.status).toBe("completed");
    await runtime.execute(identity.context, submitted.runId);
    expect(harness.run).toHaveBeenCalledTimes(2);
    return {
      ...submitted,
      inputs,
      observed,
      evidence: await runs.evidence(identity.context, submitted.runId),
    };
  }

  it("澄清回答恢复同一运行，两次 SQL 查询形成证据与终态，重试复用已提交结果", async () => {
    const result = await dialogue(full);
    expect(result.observed.map((item) => item.rows)).toEqual([
      [
        { department: "A", visits: 2 },
        { department: "B", visits: 2 },
      ],
      [{ visits: 3 }],
    ]);
    expect(result.evidence).toHaveLength(2);
    const toolAudits = await repository.listAudits(full.context, result.runId);
    expect(toolAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_name: "search_catalog", status: "completed" }),
        expect.objectContaining({ tool_name: "request_clarification", status: "completed" }),
      ]),
    );
    expect(
      toolAudits.filter((audit) => (audit as { tool_name: string }).tool_name === "query_dataset"),
    ).toHaveLength(2);
    const audit = await queryAudit(result.runId);
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => Number(row.row_count))).toEqual([2, 1]);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          analysis_run_id: result.runId,
          user_id: full.context.userId,
          organization_id: "dialogue-org",
          source_id: "dialogue",
          outcome: "executed",
          row_filter_injected: true,
        }),
      ]),
    );
    const events = await runs.events(full.context, result.runId, 0);
    expect(events.filter((event) => event.type === "clarification_answered")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run_completed")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run_completed");
    expect(events.filter((event) => event.type === "final_answer")).toEqual([
      expect.objectContaining({ content: "九月就诊总人次为 3，科室结果已保存。" }),
    ]);
    const replay = await app.inject({
      method: "GET",
      url: `/analysis-runs/${result.runId}/events`,
      headers: { authorization: `Bearer ${full.token}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.match(/event: run_completed/g)).toHaveLength(1);
  });

  it("追问使用已授权的对话、澄清答案和历史证据，保存新的查询关联", async () => {
    const initial = await dialogue(full);
    const next = await submit(full, "沿用九月范围，再确认总人次", initial.conversationId);
    let input = "";
    const runtime = executor({
      run: async (request) => {
        input = request.input;
        const result = await request.executeTool(
          "query_dataset",
          { query: totalQuery },
          "followup-total",
        );
        expect(result).toMatchObject({ success: true, output: { rows: [{ visits: 3 }] } });
        return { status: "completed", content: "沿用九月就诊日期，总人次为 3。" };
      },
    });
    await runtime.execute(full.context, next.runId);
    expect((await runs.get(full.context, next.runId)).status).toBe("completed");
    expect(input).toContain("分析九月各科室就诊人次和总人次");
    expect(input).toContain("请选择就诊统计月份");
    expect(input).toContain("2026 年 9 月");
    expect(input).toContain("九月就诊总人次为 3，科室结果已保存。");
    for (const evidence of initial.evidence) expect(input).toContain(evidence.evidence_id);
    expect(await queryAudit(initial.runId)).toHaveLength(2);
    expect(await queryAudit(next.runId)).toHaveLength(1);
    const detail = await app.inject({
      method: "GET",
      url: `/conversations/${next.conversationId}`,
      headers: { authorization: `Bearer ${full.token}` },
    });
    expect(
      detail
        .json<{ messages: { content: string }[] }>()
        .messages.filter((message) => message.content === "沿用九月就诊日期，总人次为 3。"),
    ).toHaveLength(1);
  });

  it("两个角色在相同自然语言请求下获得各自科室范围，历史会话和事件校验归属", async () => {
    const all = await dialogue(full);
    const limited = await dialogue(restricted);
    expect(all.observed[0].rows).toHaveLength(2);
    expect(limited.observed.map((item) => item.rows)).toEqual([
      [{ department: "A", visits: 2 }],
      [{ visits: 2 }],
    ]);
    for (const evidence of limited.evidence)
      expect(JSON.stringify(evidence.authorized_query)).toContain('"A"');
    expect(
      limited.inputs.every(
        (input) => !all.evidence.some((evidence) => input.includes(evidence.evidence_id)),
      ),
    ).toBe(true);
    expect(
      (await queryAudit(limited.runId)).every(
        (row) => row.user_id === restricted.context.userId && row.row_filter_injected === true,
      ),
    ).toBe(true);
    for (const path of [
      `/conversations/${all.conversationId}`,
      `/analysis-runs/${all.runId}/events`,
      `/analysis-runs/${all.runId}/evidence`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: { authorization: `Bearer ${restricted.token}` },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("绑定 Agent 的工具通过 DAS 取得授权 SQL 结果，运行快照返回实际版本", async () => {
    mkdirSync(resolve("secrets"), { recursive: true });
    const directory = mkdtempSync(join(resolve("secrets"), "agent-dialogue-scripted-"));
    try {
      const services = createAgentConfiguration({
        database,
        config: apiConfigSchema.shape.analysis_runtime.parse({
          enabled: false,
          state_directory: directory,
        }),
        startupDirectory: process.cwd(),
        skillsDirectory: fileURLToPath(new URL("../../../../packages/skills", import.meta.url)),
      });
      const manager = { ...restricted.context, roles: ["system_admin"] };
      await services.models.publish(manager, {
        model_id: "scripted-model",
        version: 1,
        name: "脚本测试",
        protocol: "responses",
        base_url: "http://localhost/v1",
        model: "scripted",
      });
      await services.agents.publish(manager, {
        agent_id: "scripted-agent",
        version: 1,
        name: "授权分析",
        model_id: "scripted-model",
        model_version: 1,
        tool_names: ["query_dataset", "read_skill_reference"],
        skill_names: ["query-dsl"],
        limits: { timeout_ms: 10000, max_tool_calls: 5, max_context_bytes: 65536 },
      });
      const conversation = await new ConversationService(new SqlConversationRepository(database), {
        selectAgent: (ctx, id, version) => services.runtime.selectAgent(ctx, id, version),
        authorizeRun: (ctx, id) => runs.get(ctx, id),
      }).create(restricted.context, "固定 Agent", { agent_id: "scripted-agent" });
      const submitted = await submit(restricted, "统计九月科室人次", conversation.id);
      const resolveConfiguration: NonNullable<
        ExecutorDependencies["resolveConfiguration"]
      > = async (ctx, id) => {
        const bound = await services.runtime.resolveRun(ctx, id);
        return {
          ...bound,
          tools: new AnalysisTools({
            ...toolDependencies,
            skills: bound.configuration.skills,
            allowedNames: bound.agent.tool_names,
          }),
          instructions: bound.agent.instructions,
          maxToolCalls: bound.agent.limits.max_tool_calls,
          maxContextBytes: bound.agent.limits.max_context_bytes,
        };
      };
      const runtime = executor(
        {
          run: async (request) => {
            expect(request.configuration?.provider.model).toBe("scripted");
            expect(request.tools.map((tool) => tool.name).sort()).toEqual([
              "query_dataset",
              "read_skill_reference",
            ]);
            expect(
              await request.executeTool(
                "query_dataset",
                { query: groupedQuery },
                "configured-query",
              ),
            ).toMatchObject({ success: true, output: { rows: [{ department: "A", visits: 2 }] } });
            return { status: "completed", content: "A 科室 2 人次" };
          },
        },
        undefined,
        resolveConfiguration,
      );
      await runtime.execute(restricted.context, submitted.runId);
      expect(await runs.get(restricted.context, submitted.runId)).toMatchObject({
        status: "completed",
        agent_id: "scripted-agent",
        agent_version: 1,
      });
      expect(await queryAudit(submitted.runId)).toEqual([
        expect.objectContaining({ row_filter_injected: true, user_id: restricted.context.userId }),
      ]);
      await runtime.close();
    } finally {
      assert.equal(dirname(directory), resolve("secrets"), "测试目录超出项目范围");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.LOCAL_MODEL_ACCEPTANCE === "1")(
    "本地模型通过普通函数查询授权科室，重启后恢复同一官方线程回答追问",
    async () => {
      mkdirSync(resolve("secrets"), { recursive: true });
      modelStateDirectory = mkdtempSync(join(resolve("secrets"), "ai-data-dialogue-model-"));
      const { runtime: runtimeConfig, agent, provider } = configuredModel!;
      const instructions = agent.instructions;
      const selected = createAgentConfiguration({
        database,
        config: { ...runtimeConfig, state_directory: modelStateDirectory },
        startupDirectory: process.cwd(),
        skillsDirectory: fileURLToPath(new URL("../../../../packages/skills", import.meta.url)),
      });
      const manager = { ...restricted.context, roles: ["system_admin"] };
      await selected.models.publish(manager, {
        model_id: "acceptance-model",
        version: 1,
        name: "验收模型",
        protocol: "responses",
        base_url: provider.baseUrl,
        model: provider.model,
        api_key: provider.apiKey,
        headers: provider.headers,
        context_window: provider.contextWindow,
      });
      await selected.agents.publish(manager, {
        agent_id: "default",
        version: 1,
        name: "验收助手",
        instructions,
        model_id: "acceptance-model",
        model_version: 1,
        tool_names: agent.tool_names,
        skill_names: agent.skill_names,
        limits: agent.limits,
      });
      const resolveConfiguration: NonNullable<
        ExecutorDependencies["resolveConfiguration"]
      > = async (context, runId) => {
        const result = await selected.runtime.resolveRun(context, runId);
        return {
          ...result,
          tools: new AnalysisTools({
            ...toolDependencies,
            skills: result.configuration.skills,
            allowedNames: result.agent.tool_names,
          }),
          instructions: result.agent.instructions,
          maxToolCalls: result.agent.limits.max_tool_calls,
          maxContextBytes: result.agent.limits.max_context_bytes,
        };
      };
      let model = configuredDialogueHarness(modelStateDirectory);
      models.push(model);
      const threadIds: string[] = [];
      const attempts: { name: string; input: unknown; output: unknown }[] = [];
      const harness: AnalysisHarness = {
        run: (request) =>
          model.run({
            ...request,
            onThreadStarted: async (id) => {
              threadIds.push(id);
              await request.onThreadStarted(id);
            },
            executeTool: async (name, input, id) => {
              const result = await request.executeTool(name, input, id);
              attempts.push({ name, input, output: result.output });
              return result;
            },
          }),
      };
      const submitted = await submit(
        restricted,
        "请统计 2026 年 9 月各科室的去重就诊人次，按科室列出结果。数据源 dialogue 的就诊样本表是 dialogue_visits，就诊日期字段为 visited_on、就诊号为 visit_id、科室为 department。请先核对业务目录，再查询我有权查看的范围。",
      );
      const runtime = executor(harness, instructions, resolveConfiguration);
      await runtime.execute(restricted.context, submitted.runId);
      const state = await runs.get(restricted.context, submitted.runId);
      expect(state.status, JSON.stringify({ error: state.error, attempts })).toBe("completed");
      const evidence = await runs.evidence(restricted.context, submitted.runId);
      expect(evidence.length).toBeGreaterThanOrEqual(1);
      expect(
        evidence.some((item) =>
          item.result.rows.some((row) => {
            const values = Object.values(row);
            return values.includes("A") && values.some((value) => value === 2 || value === "2");
          }),
        ),
        JSON.stringify({
          evidence: evidence.map((item) => ({
            query: item.authorized_query,
            rows: item.result.rows,
          })),
          attempts,
        }),
      ).toBe(true);
      expect(
        evidence.every((item) =>
          item.result.rows.every((row) => !Object.values(row).includes("B")),
        ),
      ).toBe(true);
      const successfulQueries = (await queryAudit(submitted.runId)).filter(
        (row) => row.outcome === "executed",
      );
      expect(successfulQueries.length).toBeGreaterThanOrEqual(1);
      expect(
        successfulQueries.every(
          (row) => row.user_id === restricted.context.userId && row.row_filter_injected === true,
        ),
      ).toBe(true);
      const audits = await repository.listAudits(restricted.context, submitted.runId);
      expect(
        audits.some((audit) => {
          const item = audit as { tool_name: string; status: string };
          return (
            ["search_catalog", "list_datasets", "describe_dataset"].includes(item.tool_name) &&
            item.status === "completed"
          );
        }),
      ).toBe(true);
      const answer = (await runs.events(restricted.context, submitted.runId, 0)).find(
        (event) => event.type === "final_answer",
      );
      expect(answer).toMatchObject({ content: expect.stringMatching(/A/) });
      expect(answer).toMatchObject({ content: expect.stringMatching(/\b2\b|两|二/) });
      await runtime.close();
      await model.close();
      model = configuredDialogueHarness(modelStateDirectory);
      models.push(model);
      const next = await submit(
        restricted,
        "刚才 A 科室的就诊人次加 1 是多少？直接使用上轮结果回答。",
        submitted.conversationId,
      );
      await executor(harness, instructions, resolveConfiguration).execute(
        restricted.context,
        next.runId,
      );
      const continued = await runs.get(restricted.context, next.runId);
      expect(continued.status, JSON.stringify({ error: continued.error, attempts })).toBe(
        "completed",
      );
      expect(threadIds).toHaveLength(2);
      expect(threadIds[1]).toBe(threadIds[0]);
      const bindings = await database.execute({
        sql: "SELECT agent_id,agent_version FROM dbo.analysis_runs WHERE id IN (@first,@next)",
        parameters: [
          { name: "first", type: "string", value: submitted.runId },
          { name: "next", type: "string", value: next.runId },
        ],
      });
      expect(bindings.rows).toEqual([
        { agent_id: "default", agent_version: 1 },
        { agent_id: "default", agent_version: 1 },
      ]);
      expect(await queryAudit(next.runId)).toHaveLength(0);
      const nextAnswer = (await runs.events(restricted.context, next.runId, 0)).find(
        (event) => event.type === "final_answer",
      );
      expect(nextAnswer).toMatchObject({ content: expect.stringMatching(/\b3\b|三/) });
    },
    // 查询与重建后追问各有一轮完整预算，额外预留 60 秒用于流程装配和收尾。
    configuredModel ? configuredModel.agent.limits.timeout_ms * 2 + 60000 : 240000,
  );
});
