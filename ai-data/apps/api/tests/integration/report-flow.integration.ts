import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";
import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  reportDefinitionSchema,
  reportDefinitionVersionSchema,
  reportExecutionSchema,
  stableStringify,
} from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { apiConfigSchema } from "../../src/config/api-config";
import { memoryTaskConfigSchema } from "../../src/config/memory-task-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { JwtService } from "../../src/auth/jwt-service";
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
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { SqlKnowledgeRepository } from "../../src/knowledge/sql-knowledge-repository";
import { MemoryAccess } from "../../src/memory/memory-access";
import { serialExecutor } from "../../src/memory/serial-executor";
import { createMemoryServices } from "../../src/memory/create-memory-services";
import { DataAccessSessionService } from "../../src/data-access/data-access-session-service";
import { SqlDataAccessServiceRegistry } from "../../src/data-access/sql-data-access-service-registry";
import { createReportServices } from "../../src/reports/create-report-services";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { AnalysisExecutor } from "../../src/runtime/analysis-executor";
import { SqlRuntimeRepository } from "../../src/runtime/sql-runtime-repository";
import { registerReportManagementRoutes } from "../../src/routes/report-management-routes";
import { registerReportExecutionRoutes } from "../../src/routes/report-execution-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { config, context, createApiDependencies } from "../support/api-fixtures";
import { DialogueDasFixture, readDialogueConnection } from "./dialogue-das-fixture";

const definition = reportDefinitionSchema.parse({
  title: "科室就诊",
  queries: [
    {
      query_id: "visits",
      query: {
        type: "relational_query",
        source_id: "dialogue",
        from: { object_id: "table.dbo.dialogue_visits", alias: "v" },
        select: [
          { field: "v.department", as: "department" },
          { field: "v.visit_id", aggregation: "count_distinct", as: "visits" },
        ],
        group_by: ["v.department"],
        order_by: [{ field: "v.department", direction: "asc" }],
      },
    },
  ],
  presentation: [
    {
      section_id: "s",
      title: "结果",
      blocks: [
        { block_id: "table", type: "table", title: "就诊人次", query_ids: ["visits"] },
        {
          block_id: "chart",
          type: "chart",
          title: "图",
          query_ids: ["visits"],
          chart: { type: "bar", x: "department", y: "visits" },
        },
      ],
    },
  ],
});

describe("统一报表：API、DAS HTTP、SQL 与对话事务", () => {
  const prefix = "ai_data_report_flow_" + randomUUID().replaceAll("-", "");
  const created: string[] = [];
  const das = new DialogueDasFixture();
  let admin: SqlServerMetadataDatabase,
    database: SqlServerMetadataDatabase,
    data: SqlServerMetadataDatabase;
  let reporting: ReturnType<typeof createReportServices>,
    runs: AnalysisRunService,
    conversations: ConversationService,
    knowledge: KnowledgeService;
  let transactionMemory: ReturnType<typeof createMemoryServices>;
  let app: FastifyInstance, tools: AnalysisTools, client: DataAccessQueryClient;
  let execute: MockInstance<DataAccessQueryClient["execute"]>;
  const reader = {
    ...context,
    userId: "reader",
    roles: [],
    roleIds: ["reader"],
    permissionContext: { department_ids: ["A"] },
  };
  beforeAll(async () => {
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(readDialogueConnection());
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    for (const suffix of ["api", "das"]) {
      const name = `${prefix}_${suffix}`;
      await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
      created.push(name);
    }
    database = await SqlServerMetadataDatabase.connect({
      ...connection,
      database: created[0],
      options: { ...connection.options, pool: { ...connection.options.pool, max: 1 } },
    });
    data = await SqlServerMetadataDatabase.connect({ ...connection, database: created[1] });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await data.execute({
      sql: "CREATE TABLE dbo.dialogue_visits(visit_id INT NOT NULL,department NVARCHAR(8) NOT NULL,visited_on DATE NOT NULL); INSERT INTO dbo.dialogue_visits VALUES(1,'A','2026-09-10'),(2,'A','2026-09-10'),(2,'B','2026-09-10'),(3,'B','2026-09-10')",
      parameters: [],
    });
    const authRepository = new SqlAuthRepository(database);
    await authRepository.ensureBootstrapAdmin({
      userId: context.userId,
      organizationId: context.organizationId,
      organizationCode: "reports",
      organizationName: "报表验收",
      username: "report-test",
      displayName: "测试",
      passwordHash: "test-hash",
    });
    await authRepository.createSession({
      id: context.sessionId,
      userId: context.userId,
      refreshTokenHash: "report-test",
      expiresAt: dayjs().add(1, "hour").toDate(),
      revokedAt: null,
    });
    await database.execute({
      sql: "INSERT INTO dbo.users(id,organization_id,username,display_name,status) VALUES('reader','org','reader',N'读者','active'); INSERT INTO dbo.roles(id,code,name) VALUES('reader','reader',N'读者')",
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
    await das.start({ ...connection, database: created[1] }, publicKey);
    const catalogClient = await das.expose({ ...connection, database: created[1] }, jwt);
    const catFor = (executor: MetadataQueryExecutor) => {
      const repo = new SqlCatalogRepository(
        executor === database ? executor : serialExecutor(executor),
      );
      return new BusinessCatalogService(
        {
          listRawCatalog: (sourceId) =>
            catalogClient.listCatalog(das.serviceUrl, sourceId, das.serviceId),
        },
        repo,
        repo,
      );
    };
    const authFor = (executor: MetadataQueryExecutor) =>
      new QueryAuthorizationService(catFor(executor), jwt);
    const catalog = catFor(database),
      authorization = authFor(database);
    const catalogRepo = new SqlCatalogRepository(database);
    await catalogRepo.saveObjectPermission("dialogue", {
      role_id: "reader",
      object_id:
        definition.queries[0].query.type === "relational_query"
          ? definition.queries[0].query.from.object_id
          : "",
      effect: "allow",
    });
    await catalogRepo.saveRowPolicy("dialogue", {
      role_id: "reader",
      object_id: "table.dbo.dialogue_visits",
      effect: "allow",
      condition: { field: "department", op: "in", value_from: "permission_context.department_ids" },
    });
    client = new DataAccessQueryClient({
      listHealthyServices: async () => [
        {
          serviceId: das.serviceId,
          serviceUrl: das.serviceUrl,
          serviceVersion: "test",
          status: "healthy",
          lastHeartbeatAt: dayjs().toDate(),
          message: null,
          sources: [
            { source_id: "dialogue", status: "healthy", checked_at: "2026-09-21 08:00:00" },
          ],
        },
      ],
    });
    execute = vi.spyOn(client, "execute");
    runs = new AnalysisRunService({
      repository: new SqlAnalysisRunRepository(database),
      authorization,
      client,
      refreshContext: async (current) => current,
      completeOperation: (current, id, tx, content) => reporting.complete(current, id, tx, content),
    });
    const trusted = [{ service_id: das.serviceId, credential_version: 1, enabled: true }];
    const dataAccessSessions = new DataAccessSessionService(
      new SqlDataAccessServiceRegistry(database),
      jwt,
      trusted,
    );
    await dataAccessSessions.register(
      {
        service_id: das.serviceId,
        service_port: Number(new URL(das.serviceUrl).port),
        service_protocol: "http",
        status: "healthy",
        sent_at: "2026-09-27 18:00:00",
        sources: [{ source_id: "dialogue", status: "healthy", checked_at: "2026-09-27 18:00:00" }],
      },
      das.serviceUrl,
      await dataAccessSessions.issueCredential(das.serviceId),
    );
    transactionMemory = createMemoryServices({
      database,
      config: {
        ...config,
        trusted_data_access_services: trusted,
        memory_tasks: memoryTaskConfigSchema.parse({ enabled: false }),
      },
      jwt,
      catalogClient,
      dataAccessSessions,
      queryAuthorization: authorization,
      runs,
      refreshContext: async (current) => current,
      isForegroundBusy: () => false,
      onError: (error) => {
        throw error;
      },
    });
    const access = new MemoryAccess({ database, catalog: catFor, authorization: authFor });
    const metricsFor = (executor: MetadataQueryExecutor) =>
      new MetricService(new SqlMetricRepository(executor), authFor(executor), runs, {
        authorizeScope: (current, scope) => access.scope(current, scope, executor),
        authorizationForExecutor: authFor,
      });
    const metrics = metricsFor(database);
    conversations = new ConversationService(new SqlConversationRepository(database));
    reporting = createReportServices({
      database,
      runs,
      catalog,
      authorization,
      metrics,
      catalogForExecutor: catFor,
      authorizationForExecutor: authFor,
      metricsForExecutor: metricsFor,
      access,
      conversations,
      refreshContext: async (current) => current,
      selectAgent: async () => ({ agentId: "report-test", agentVersion: 1 }),
    });
    knowledge = new KnowledgeService({
      repository: new SqlKnowledgeRepository(database),
      metrics,
      authorizeScope: access.scope.bind(access),
      validateSource: access.source.bind(access),
      templates: reporting.templates,
    });
    tools = new AnalysisTools({
      runs,
      catalog,
      metrics,
      reports: reporting.reports,
      reportEditing: reporting.revisions,
      reportExecutions: reporting.executions,
      refreshContext: async (current) => current,
      listSourceIds: async () => ["dialogue"],
      allowedNames: ["get_report_definition", "save_report_definition", "get_report_execution"],
    });
    app = Fastify({ logger: false });
    registerContractErrorHandler(app);
    const auth = createApiDependencies().auth;
    registerReportManagementRoutes(app, auth, reporting);
    registerReportExecutionRoutes(app, auth, reporting);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await das.close();
    await database?.close();
    await data?.close();
    try {
      for (const name of created) {
        if (!/^ai_data_report_flow_[a-f0-9]{32}_(api|das)$/.test(name))
          throw new Error("隔离库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  const headers = { authorization: "Bearer test" };
  it("单连接 SQL 事务通过正式记忆工厂复用已注册 DAS 会话", async () => {
    await database.transaction(async (executor) => {
      await transactionMemory.access.scope(context, { source_id: "dialogue" }, executor);
      const authorized = await transactionMemory
        .authorizationForExecutor(executor)
        .authorize(definition.queries[0].query, context);
      expect(authorized.request.query.source_id).toBe("dialogue");
    });
  });
  it("API保存、追加科室参数、独立执行、重试和导出，两个展示只查询一次", async () => {
    const before = execute.mock.calls.length;
    const saved = await app.inject({
      method: "POST",
      url: "/report-definitions",
      headers,
      payload: { definition },
    });
    expect(saved.statusCode).toBe(201);
    const first = reportDefinitionVersionSchema.parse(saved.json());
    const edited = reportDefinitionSchema.parse({
      ...definition,
      parameters: [{ name: "department", label: "科室", data_type: "string", required: true }],
      queries: definition.queries.map((query) => ({
        ...query,
        bindings: [
          {
            parameter: "department",
            target: { type: "filter", scope: "query", field: "v.department", op: "eq" },
          },
        ],
      })),
    });
    const updated = await app.inject({
      method: "PUT",
      url: `/reports/${first.report_id}/definition`,
      headers,
      payload: { expected_version: 1, definition: edited },
    });
    expect(updated.statusCode).toBe(200);
    expect(execute.mock.calls.length).toBe(before);
    const request = {
      definition_version: 2,
      idempotency_key: "one",
      parameters: { department: "A" },
    };
    const response = await app.inject({
      method: "POST",
      url: `/reports/${first.report_id}/execute`,
      headers,
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    const result = reportExecutionSchema.parse(response.json());
    expect(result.status).toBe("completed");
    const executionRun = await runs.get(context, result.analysis_run_id);
    expect((await conversations.list(context)).map((item) => item.id)).not.toContain(
      executionRun.conversation_id,
    );
    expect(result.results[0].evidence.result.execution_sql).toMatchObject({
      dialect: "sqlserver",
      sql: expect.stringContaining("SELECT"),
      parameters: expect.any(Array),
    });
    expect(result.results[0].evidence.result.rows).toEqual([{ department: "A", visits: 2 }]);
    expect(execute.mock.calls.length).toBe(before + 1);
    expect(
      (await reporting.executions.execute(context, first.report_id, request)).execution_id,
    ).toBe(result.execution_id);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/report-executions/${result.execution_id}/export-content`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await reporting.management.exportReport(context, first.report_id)).report.execution_id,
    ).toBe(result.execution_id);
    expect(execute.mock.calls.length).toBe(before + 1);
  });
  it("多查询保存完整来源，共享读者不能读取较大范围旧结果且新运行只查A科室", async () => {
    const second = {
      ...definition.queries[0],
      query_id: "total",
      query: {
        ...definition.queries[0].query,
        select: [{ field: "v.visit_id", aggregation: "count_distinct", as: "visits" }],
        group_by: [],
        order_by: [],
      },
    };
    const saved = await reporting.definitions.save(context, {
      definition: reportDefinitionSchema.parse({
        ...definition,
        queries: [...definition.queries, second],
      }),
      shared_with: ["reader"],
    });
    const full = await reporting.executions.execute(context, saved.report_id, {
      definition_version: 1,
      idempotency_key: "full",
    });
    expect(full.status).toBe("completed");
    expect(full.results).toHaveLength(2);
    await expect(reporting.executions.get(reader, full.execution_id)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
    const own = await reporting.executions.execute(reader, saved.report_id, {
      definition_version: 1,
      idempotency_key: "own",
    });
    expect(own.status).toBe("completed");
    expect(own.results[0].evidence.result.rows).toEqual([{ department: "A", visits: 2 }]);
    await reporting.definitions.share(context, saved.report_id, {
      expected_version: 1,
      shared_with: [],
    });
    await expect(reporting.executions.get(reader, own.execution_id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("对话工具读取同一定义，成功时提交新版本；并发版本冲突和取消不覆盖定义", async () => {
    const saved = await reporting.definitions.save(context, { definition });
    const run = await reporting.revisions.revise(context, saved.report_id, {
      expected_version: 1,
      prompt: "改标题",
      idempotency_key: "edit",
    });
    const queryCalls = execute.mock.calls.length;
    expect((await conversations.list(context)).map((item) => item.id)).not.toContain(
      run.conversation_id,
    );
    const binding = {
      report_id: saved.report_id,
      analysis_run_id: run.analysis_run_id,
      expected_version: 1,
    };
    expect(
      await reporting.revisions.binding(context, saved.report_id, run.analysis_run_id),
    ).toEqual(binding);
    for (const identity of [reader, { ...context, organizationId: "other" }])
      await expect(
        reporting.revisions.binding(identity, saved.report_id, run.analysis_run_id),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      reporting.revisions.binding(context, randomUUID(), run.analysis_run_id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(execute.mock.calls.length).toBe(queryCalls);
    expect((await reporting.definitions.get(context, saved.report_id)).version).toBe(1);
    const executor = new AnalysisExecutor({
      runs,
      tools,
      repository: new SqlRuntimeRepository(database),
      refreshContext: async (current) => current,
      instructions: "修改报表",
      loadReportContext: reporting.revisions.read.bind(reporting.revisions),
      harness: {
        run: async (request) => {
          expect(JSON.parse(request.input).report.report_id).toBe(saved.report_id);
          expect(
            (
              await request.executeTool(
                "save_report_definition",
                { definition: { ...definition, title: "对话标题" } },
                "edit",
              )
            ).success,
          ).toBe(true);
          expect((await reporting.definitions.get(context, saved.report_id)).version).toBe(1);
          return { status: "completed", content: "标题已更新" };
        },
      },
    });
    await executor.execute(context, run.analysis_run_id);
    await executor.close();
    expect((await runs.get(context, run.analysis_run_id)).status).toBe("completed");
    expect(
      await reporting.revisions.binding(context, saved.report_id, run.analysis_run_id),
    ).toEqual(binding);
    expect((await reporting.definitions.get(context, saved.report_id)).definition.title).toBe(
      "对话标题",
    );
    expect(
      await reporting.revisions.revise(context, saved.report_id, {
        expected_version: 1,
        prompt: "改标题",
        idempotency_key: "edit",
      }),
    ).toEqual(run);
    const conflict = await reporting.revisions.revise(context, saved.report_id, {
      expected_version: 2,
      prompt: "再改",
      idempotency_key: "conflict",
    });
    const lease = await runs.claim(context, conflict.analysis_run_id, "edit");
    await reporting.revisions.stage(context, conflict.analysis_run_id, lease, {
      definition: { ...definition, title: "晚到" },
    });
    await reporting.definitions.save(
      context,
      { definition: { ...definition, title: "画布标题" } },
      saved.report_id,
      2,
    );
    await expect(
      runs.complete(context, conflict.analysis_run_id, lease, "完成"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await runs.cancel(context, conflict.analysis_run_id);
    expect((await reporting.definitions.get(context, saved.report_id)).definition.title).toBe(
      "画布标题",
    );
  });
  it("旧save_report快照在成功完成后具备同ID定义，人工保存也是同一模型", async () => {
    const conversation = await conversations.create(context);
    const message = await conversations.submitUserMessage(
      context,
      conversation.id,
      "保存报告",
      randomUUID(),
    );
    const id = message!.analysisRun.id,
      lease = await runs.claim(context, id, "save");
    const evidence = await runs.query(context, id, lease, "query", definition.queries[0].query);
    await runs.query(context, id, lease, "other-result", definition.queries[0].query);
    const input = {
      analysis_run_id: id,
      title: "对话报告",
      description: "长期复用的科室查询",
      sections: [
        {
          section_id: "s",
          title: "结果",
          blocks: [
            { block_id: "b", title: "结果", type: "table", evidence_ids: [evidence.evidence_id] },
          ],
        },
      ],
    };
    const snapshot = await reporting.reports.save(context, input, undefined, undefined, {
      lease,
      key: "save",
    });
    await runs.complete(context, id, lease, "已保存");
    expect(
      (await reporting.definitions.get(context, snapshot.report_id)).definition.queries,
    ).toHaveLength(1);
    const manual = await reporting.reports.save(context, input);
    expect(manual.sources.map((source) => source.evidence_id)).toEqual([evidence.evidence_id]);
    expect(
      (await reporting.definitions.get(context, manual.report_id)).definition.description,
    ).toBe(input.description);
    expect(
      (await reporting.management.list(context)).items.find(
        (item) => item.report_id === manual.report_id,
      ),
    ).toMatchObject({ display_type: "table", description: input.description });
    expect(
      (await reporting.definitions.get(context, manual.report_id)).source_analysis_run_id,
    ).toBe(id);
    await conversations.delete(context, [conversation.id]);
    expect(await conversations.get(context, conversation.id)).toBeNull();
    expect((await reporting.reports.get(context, manual.report_id)).report_id).toBe(
      manual.report_id,
    );
    expect(
      (await reporting.management.exportReport(context, manual.report_id)).tables,
    ).toHaveLength(1);
  });
  it("分析说明只引用指定执行，导出携带说明且新运行不复制旧结论", async () => {
    const saved = await reporting.definitions.save(context, { definition });
    const result = await reporting.executions.execute(context, saved.report_id, {
      definition_version: 1,
      idempotency_key: "narrative-source",
    });
    const before = execute.mock.calls.length;
    const createdRun = await reporting.revisions.narrate(context, result.execution_id, {
      prompt: "说明结果",
      idempotency_key: "narrative",
    });
    expect((await conversations.list(context)).map((item) => item.id)).not.toContain(
      createdRun.conversation_id,
    );
    await expect(
      reporting.revisions.binding(context, saved.report_id, createdRun.analysis_run_id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const lease = await runs.claim(context, createdRun.analysis_run_id, "narrative");
    expect(
      (
        await tools.execute(
          context,
          createdRun.analysis_run_id,
          lease,
          "get_report_execution",
          { execution_id: result.execution_id },
          "read",
        )
      ).success,
    ).toBe(true);
    expect(
      (
        await tools.execute(
          context,
          createdRun.analysis_run_id,
          lease,
          "save_report_definition",
          { definition },
          "bad",
        )
      ).success,
    ).toBe(false);
    await runs.complete(context, createdRun.analysis_run_id, lease, "A 科室与 B 科室各有 2 人次。");
    expect(
      (await reporting.executions.exportContent(context, result.execution_id)).narratives,
    ).toHaveLength(1);
    expect(execute.mock.calls.length).toBe(before);
    const next = await reporting.executions.execute(context, saved.report_id, {
      definition_version: 1,
      idempotency_key: "narrative-next",
    });
    expect(
      (await reporting.executions.exportContent(context, next.execution_id)).narratives,
    ).toEqual([]);
  });
  it("分享候选在真实 SQL 中隔离组织、状态、作者并按字面搜索和翻页", async () => {
    await database.execute({
      sql: "INSERT INTO dbo.organizations(id,code,name) VALUES('share-org','share-org',N'隔离组织'); INSERT INTO dbo.users(id,organization_id,username,display_name,status) VALUES('share-a','org','share-a',N'分享同名成员','active'),('share-b','org','share-b',N'分享同名成员','active'),('share-c','org','share-c',N'分享同名成员','disabled'),('share-d','share-org','share-d',N'分享同名成员','active'),('share-e','org','share-e',@literal,'active')",
      parameters: [{ name: "literal", type: "string", value: "字面%_[测]\\字符" }],
    });
    const saved = await reporting.definitions.save(context, { definition });
    const first = await reporting.sharing.candidates(context, saved.report_id, {
      search: "分享同名",
      limit: 1,
    });
    expect(first.items.map((item) => item.user_id)).toEqual(["share-a"]);
    expect(first.next_cursor).toBe("share-a");
    const last = await reporting.sharing.candidates(context, saved.report_id, {
      search: "分享同名",
      cursor: first.next_cursor,
      limit: 1,
    });
    expect(last.items.map((item) => item.user_id)).toEqual(["share-b"]);
    expect(last.next_cursor).toBeUndefined();
    expect(
      (
        await reporting.sharing.candidates(context, saved.report_id, { search: "%_[测]\\" })
      ).items.map((item) => item.user_id),
    ).toEqual(["share-e"]);
    expect(
      (await reporting.sharing.candidates(context, saved.report_id, {})).items.some(
        (item) => item.user_id === context.userId,
      ),
    ).toBe(false);
    await expect(reporting.sharing.get(reader, saved.report_id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("分享读取保留停用账号，移除名单后采用真实新版本", async () => {
    const saved = await reporting.definitions.save(context, {
      definition,
      shared_with: ["reader"],
    });
    await database.execute({
      sql: "UPDATE dbo.users SET status='disabled' WHERE id='reader'",
      parameters: [],
    });
    try {
      const sharing = await reporting.sharing.get(context, saved.report_id);
      expect(sharing.members).toEqual([
        { user_id: "reader", username: "reader", display_name: "读者", status: "disabled" },
      ]);
      await reporting.management.share(context, saved.report_id, {
        expected_version: sharing.expected_version,
        shared_with: [],
      });
      expect(await reporting.sharing.get(context, saved.report_id)).toMatchObject({
        expected_version: 2,
        shared_with: [],
        members: [],
      });
    } finally {
      await database.execute({
        sql: "UPDATE dbo.users SET status='active' WHERE id='reader'",
        parameters: [],
      });
    }
  });
  it("组织模板审核发布固定版本，私有新版本不泄露，停用立即停止组织发现", async () => {
    const saved = await reporting.definitions.save(context, { definition });
    const candidate = await knowledge.submit(context, {
      idempotency_key: "publish",
      content: {
        type: "report_template",
        report_id: saved.report_id,
        definition_version: 1,
        definition_hash: createHash("sha256")
          .update(stableStringify(saved.definition))
          .digest("hex"),
      },
      scope: { source_id: "dialogue" },
    });
    await knowledge.assignOwner(context, candidate.candidate_id, context.userId, 1);
    await knowledge.review(context, candidate.candidate_id, {
      expected_version: 1,
      decision: "approve",
      comment: "通过",
    });
    const publication = await knowledge.publish(context, candidate.candidate_id, {
      expected_version: 1,
      effective_at: "2026-09-20 00:00:00",
    });
    await reporting.definitions.save(
      context,
      { definition: { ...definition, title: "待审核内容" } },
      saved.report_id,
      1,
    );
    expect((await reporting.definitions.get(reader, saved.report_id)).version).toBe(1);
    await expect(reporting.definitions.get(reader, saved.report_id, 2)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const result = await reporting.executions.execute(reader, saved.report_id, {
      definition_version: 1,
      idempotency_key: "published",
    });
    expect(result.status).toBe("completed");
    await knowledge.setEnabled(context, publication.knowledge_id, false);
    await expect(reporting.definitions.get(reader, saved.report_id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
