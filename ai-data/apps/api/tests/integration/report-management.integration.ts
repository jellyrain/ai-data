import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  reportDefinitionSchema,
  queryDslSchema,
  type ReportDefinitionVersion,
} from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { ConversationService } from "../../src/conversations/conversation-service";
import { SqlAnalysisRunRepository } from "../../src/analysis-runs/sql-analysis-run-repository";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { SqlReportDefinitionRepository } from "../../src/reports/sql-report-definition-repository";
import { ReportDefinitionService } from "../../src/reports/report-definition-service";
import { SqlReportRepository } from "../../src/reports/sql-report-repository";
import { ReportService } from "../../src/reports/report-service";
import { ReportManagementService } from "../../src/reports/report-management-service";
import { SqlReportManagementRepository } from "../../src/reports/sql-report-management-repository";
import { context } from "../support/api-fixtures";

const definition = reportDefinitionSchema.parse({
  title: "就诊分析",
  queries: [
    {
      query_id: "visits",
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id" }],
      },
    },
  ],
  presentation: [
    {
      section_id: "s",
      title: "结果",
      blocks: [{ block_id: "b", type: "table", title: "表格", query_ids: ["visits"] }],
    },
  ],
});

describe("SQL Server：统一报表定义、版本与正式产物", () => {
  const name = "ai_data_report_management_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let created = false;
  let repository: SqlReportDefinitionRepository;
  let definitions: ReportDefinitionService;
  let reports: ReportService;
  let management: ReportManagementService;
  let conversations: ConversationService;
  let runs: AnalysisRunService;
  const execute = vi.fn(async () => ({
    columns: [{ name: "id", data_type: "integer" as const }],
    rows: [{ id: 1 }],
    row_count: 1,
    truncated: false,
  }));
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
      organizationCode: "reports",
      organizationName: "报表测试",
      username: "test",
      displayName: "测试",
      passwordHash: "test-hash",
    });
    await database.execute({
      sql: "INSERT INTO dbo.users(id,organization_id,username,display_name,status) VALUES('reader','org','reader',N'读者','active'),('disabled','org','disabled',N'停用','disabled')",
      parameters: [],
    });
    repository = new SqlReportDefinitionRepository(database);
    definitions = new ReportDefinitionService({
      repository,
      validateDefinition: async (_context, _definition, executor) => {
        if (executor) await executor.execute({ sql: "SELECT 1 AS healthy", parameters: [] });
      },
      authorizeEvidence: async () => undefined,
    });
    const authorization = {
      authorize: async (input: unknown) => ({
        request: { query: queryDslSchema.parse(input), access: { output_masks: [] } },
        token: "test",
      }),
    } as unknown as ConstructorParameters<typeof ReportService>[2];
    runs = new AnalysisRunService({
      repository: new SqlAnalysisRunRepository(database),
      authorization,
      client: { execute },
      refreshContext: async (current) => current,
    });
    conversations = new ConversationService(new SqlConversationRepository(database));
    reports = new ReportService(new SqlReportRepository(database), runs, authorization, {
      source: repository.source.bind(repository),
      assertActiveUsers: repository.assertActiveUsers.bind(repository),
      findDefinitionHead: async (current, id) =>
        (await repository.find(
          "report",
          current.organizationId,
          id,
        )) as ReportDefinitionVersion | null,
    });
    management = new ReportManagementService({
      repository: new SqlReportManagementRepository(database),
      definitions,
      reports,
      source: repository.source.bind(repository),
      runs,
      conversations,
    });
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_report_management_test_[a-f0-9]{32}$/.test(name))
          throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  it("两个旧版本写入只有一个成功，外部事务失败回滚定义和版本", async () => {
    const first = await definitions.save(context, { definition });
    const results = await Promise.allSettled([
      definitions.save(
        context,
        { definition: { ...definition, title: "编辑A" } },
        first.report_id,
        1,
      ),
      definitions.save(
        context,
        { definition: { ...definition, title: "编辑B" } },
        first.report_id,
        1,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await definitions.versions(context, first.report_id)).toHaveLength(2);
    await expect(
      database.transaction(async (executor) => {
        await definitions.save(context, { definition }, "rollback", 0, executor);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await repository.find("report", "org", "rollback")).toBeNull();
  });
  it("分享在事务内验证同组织活跃账号，撤销同时限制历史定义", async () => {
    const first = await definitions.save(context, { definition, shared_with: ["reader"] });
    await expect(
      definitions.share(context, first.report_id, {
        expected_version: 1,
        shared_with: ["disabled"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await definitions.get(context, first.report_id)).version).toBe(1);
    await definitions.share(context, first.report_id, { expected_version: 1, shared_with: [] });
    await expect(
      definitions.get({ ...context, userId: "reader" }, first.report_id, 1),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("运行中保存的工具产物仅在完成后公开，导出不增加业务执行次数", async () => {
    const conversation = await conversations.create(context);
    const submitted = await conversations.submitUserMessage(
      context,
      conversation.id,
      "查询",
      randomUUID(),
    );
    const runId = submitted!.analysisRun.id;
    const lease = await runs.claim(context, runId, "report-test");
    const evidence = await runs.query(context, runId, lease, "table", definition.queries[0].query);
    const input = {
      analysis_run_id: runId,
      title: "表",
      sections: [
        {
          section_id: "s",
          title: "结果",
          blocks: [
            { block_id: "b", type: "table", title: "表", evidence_ids: [evidence.evidence_id] },
          ],
        },
      ],
    };
    const report = await reports.save(context, input, undefined, undefined, {
      lease,
      key: "report",
    });
    await expect(management.artifacts(context, runId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reports.save(context, input)).rejects.toMatchObject({ code: "CONFLICT" });
    await runs.complete(context, runId, lease, "已完成");
    const calls = execute.mock.calls.length;
    const artifacts = await management.artifacts(context, runId);
    expect(artifacts).toHaveLength(1);
    await expect(
      definitions.saveBlock(context, {
        definition,
        source_analysis_run_id: runId,
        source_artifact_id: "foreign-artifact",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const block = await definitions.saveBlock(context, {
      definition,
      source_analysis_run_id: runId,
      source_artifact_id: artifacts[0].artifact_id,
    });
    expect(block.source_artifact_id).toBe(artifacts[0].artifact_id);
    expect((await management.exportReport(context, report.report_id)).tables[0].availability).toBe(
      "complete",
    );
    expect((await management.exportConversation(context, conversation.id)).artifacts).toHaveLength(
      1,
    );
    expect(execute).toHaveBeenCalledTimes(calls);
  });
  it("人工保存同时创建相同报表标识的定义，定义失败使快照和产物一起回滚", async () => {
    const conversation = await conversations.create(context);
    const submitted = await conversations.submitUserMessage(
      context,
      conversation.id,
      "查询",
      randomUUID(),
    );
    const runId = submitted!.analysisRun.id;
    const evidence = await runs.execute(context, runId, "result", definition.queries[0].query);
    let fail = true;
    const atomicReports = new ReportService(
      new SqlReportRepository(database),
      runs,
      {} as ConstructorParameters<typeof ReportService>[2],
      {
        source: repository.source.bind(repository),
        assertActiveUsers: repository.assertActiveUsers.bind(repository),
        findDefinitionHead: async () => null,
        onSaved: async (current, report, executor) => {
          await definitions.save(current, { definition }, report.report_id, 0, executor);
          if (fail) throw new Error("definition failed");
        },
      },
    );
    const input = {
      analysis_run_id: runId,
      title: "手工保存",
      sections: [
        {
          section_id: "s",
          title: "结果",
          blocks: [
            { block_id: "b", type: "table", title: "表", evidence_ids: [evidence.evidence_id] },
          ],
        },
      ],
    };
    await expect(atomicReports.save(context, input)).rejects.toThrow("definition failed");
    const absent = await database.execute({
      sql: "SELECT report_id FROM dbo.saved_reports WHERE JSON_VALUE(report_json,'$.analysis_run_id')=@run",
      parameters: [{ name: "run", type: "string", value: runId }],
    });
    expect(absent.rows).toEqual([]);
    expect(await management.artifacts(context, runId)).toEqual([]);
    fail = false;
    const saved = await atomicReports.save(context, input);
    expect((await definitions.get(context, saved.report_id)).version).toBe(1);
    expect(await management.artifacts(context, runId)).toHaveLength(1);
  });
});
