import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  metricDefinitionSchema,
  queryResultSchema,
  stableStringify,
  type Dataset,
  type MetricDefinition,
  type QueryDsl,
} from "@ai-data/contracts";
import type { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { JwtService } from "../../src/auth/jwt-service";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import type { AuthContext } from "../../src/auth/auth-types";
import { SqlCatalogRepository } from "../../src/catalog/sql-catalog-repository";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { ConversationService } from "../../src/conversations/conversation-service";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { SqlAnalysisRunRepository } from "../../src/analysis-runs/sql-analysis-run-repository";
import { MetricService } from "../../src/metrics/metric-service";
import { SqlMetricRepository } from "../../src/metrics/sql-metric-repository";
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { SqlKnowledgeRepository } from "../../src/knowledge/sql-knowledge-repository";
import { serialExecutor } from "../../src/memory/serial-executor";
import { ReportService } from "../../src/reports/report-service";
import { SqlReportRepository } from "../../src/reports/sql-report-repository";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { config, context as administrator } from "../support/api-fixtures";

const visitMetric = metricDefinitionSchema.parse({
  metric_id: "visit_count",
  version: 1,
  name: "就诊人次",
  description: "按就诊日期统计不同就诊号",
  aliases: [],
  grain: "就诊号",
  deduplication_keys: ["v.visit_id"],
  date_basis: { field: "v.visited_on", data_type: "date" },
  dimensions: ["v.department"],
  total_rule: "recalculate",
  value: { type: "column", column: "value" },
  query: {
    type: "relational_query",
    source_id: "clinical",
    from: { object_id: "visits", alias: "v" },
    select: [{ field: "v.visit_id", aggregation: "count_distinct", as: "value" }],
  },
});
const ratioMetric = metricDefinitionSchema.parse({
  ...visitMetric,
  metric_id: "cost_per_unit",
  name: "单位费用",
  grain: "记录",
  deduplication_keys: [],
  value: { type: "ratio", numerator: "numerator", denominator: "denominator" },
  query: {
    ...visitMetric.query,
    select: [
      { field: "v.cost", aggregation: "sum", as: "numerator" },
      { field: "v.units", aggregation: "sum", as: "denominator" },
    ],
  },
});

/** API 业务验收使用真实目录授权、事务仓储及 SQL 样本。DAS 编译器在 DAS 集成入口独立验证。 */
function registerBusinessAcceptance(databaseProvider: () => SqlServerMetadataDatabase): void {
  describe("隔离就诊样本业务验收", () => {
    let database: SqlServerMetadataDatabase;
    let auth: SqlAuthRepository;
    let catalogRepository: SqlCatalogRepository;
    let catalog: BusinessCatalogService;
    let authorization: QueryAuthorizationService;
    let metrics: MetricService;
    let knowledge: KnowledgeService;
    let runs: AnalysisRunService;
    let reports: ReportService;
    let conversations: ConversationService;
    let full: AuthContext;
    let restricted: AuthContext;
    beforeAll(async () => {
      database = databaseProvider();
      auth = new SqlAuthRepository(database);
      catalogRepository = new SqlCatalogRepository(database);
      await database.execute({
        sql: `CREATE TABLE dbo.acceptance_visits (visit_id INT, department NVARCHAR(8), visited_on DATE, registered_on DATE, cost INT, units INT);
        INSERT INTO dbo.acceptance_visits VALUES (1,'A','2026-09-10','2026-08-31',10,1),(2,'A','2026-09-10','2026-09-01',30,1),(2,'B','2026-09-10','2026-09-01',90,9),(3,'B','2026-09-10','2026-08-31',0,1),(9,'A','2026-08-30','2026-09-01',999,1);
        INSERT INTO dbo.roles (id,code,name) VALUES ('clinical-full','clinical-full',N'双部门'),('clinical-a','clinical-a',N'A 部门');
        INSERT INTO dbo.users(id,organization_id,username,display_name,status) VALUES ('clinical-full','org','clinical-full',N'双部门用户','active'),('clinical-a','org','clinical-a',N'A 部门用户','active');
        INSERT INTO dbo.user_roles VALUES ('clinical-full','clinical-full'),('clinical-a','clinical-a');`,
        parameters: [],
      });
      for (const role of ["clinical-full", "clinical-a"]) {
        await catalogRepository.saveObjectPermission("clinical", {
          role_id: role,
          object_id: "visits",
          effect: "allow",
        });
        await catalogRepository.saveRowPolicy("clinical", {
          role_id: role,
          object_id: "visits",
          effect: "allow",
          condition: {
            field: "department",
            op: "in",
            value_from: "permission_context.department_ids",
          },
        });
      }
      await auth.updateUserDepartments("clinical-full", "org", ["A", "B"]);
      await auth.updateUserDepartments("clinical-a", "org", ["A"]);
      full = {
        ...administrator,
        userId: "clinical-full",
        ...(await auth.loadAuthorization("clinical-full")),
      };
      restricted = {
        ...administrator,
        userId: "clinical-a",
        ...(await auth.loadAuthorization("clinical-a")),
      };
      const dataset: Dataset = {
        source_id: "clinical",
        object_id: "visits",
        name: "就诊样本",
        kind: "table",
        query_parameters: [],
        columns: [
          { name: "visit_id", data_type: "integer", nullable: false },
          { name: "department", data_type: "string", nullable: false },
          { name: "visited_on", data_type: "date", nullable: false },
          { name: "registered_on", data_type: "date", nullable: false },
          { name: "cost", data_type: "integer", nullable: false },
          { name: "units", data_type: "integer", nullable: false },
        ],
      };
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwt = await JwtService.create({
        ...config,
        jwt: {
          ...config.jwt,
          signing_private_key_pem: keys.privateKey
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
          verification_public_key_pem: keys.publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        },
      });
      catalog = new BusinessCatalogService(
        { listRawCatalog: async () => [dataset] },
        catalogRepository,
        catalogRepository,
      );
      authorization = new QueryAuthorizationService(catalog, jwt);
      runs = new AnalysisRunService({
        repository: new SqlAnalysisRunRepository(database),
        authorization,
        refreshContext: async (context) => ({
          ...context,
          ...(await auth.loadAuthorization(context.userId)),
        }),
        client: {
          execute: async (authorized) => {
            const { access, query, signature } = authorized.request;
            expect(
              verify(
                "RSA-SHA256",
                Buffer.from(stableStringify({ access, query })),
                keys.publicKey,
                Buffer.from(signature, "base64url"),
              ),
            ).toBe(true);
            return executeFixture(query);
          },
        },
      });
      metrics = new MetricService(new SqlMetricRepository(database), authorization, runs, {
        authorizationForExecutor: (executor) => {
          const repository = new SqlCatalogRepository(serialExecutor(executor));
          return new QueryAuthorizationService(
            new BusinessCatalogService(
              { listRawCatalog: async () => [dataset] },
              repository,
              repository,
            ),
            jwt,
          );
        },
      });
      knowledge = new KnowledgeService({
        repository: new SqlKnowledgeRepository(database),
        metrics,
        authorizeScope: async () => {},
        validateSource: async () => {},
      });
      reports = new ReportService(new SqlReportRepository(database), runs, authorization);
      conversations = new ConversationService(new SqlConversationRepository(database));
      await publishMetric(visitMetric);
      await publishMetric(ratioMetric);
    });

    /** SQL 样本正式指标通过同一负责人审核发布流程建立。 */
    async function publishMetric(metric: MetricDefinition) {
      const candidate = await knowledge.submitMetric(administrator, metric);
      if (candidate.status !== "published") {
        await knowledge.assignOwner(
          administrator,
          candidate.candidate_id,
          administrator.userId,
          candidate.version,
        );
        await knowledge.review(administrator, candidate.candidate_id, {
          expected_version: candidate.version,
          decision: "approve",
          comment: "样本口径审核通过",
        });
      }
      return knowledge.publish(administrator, candidate.candidate_id, {
        expected_version: candidate.version,
        effective_at: "2026-01-01 00:00:00",
      });
    }

    /** 只接受此样本的两类聚合模板，将授权后的日期和部门值绑定到实际 SQL。 */
    async function executeFixture(query: QueryDsl) {
      if (query.type !== "relational_query") throw new Error("预期关系查询");
      expect(query.from.object_id).toBe("visits");
      expect(query.joins).toEqual([]);
      const range = query.filters.items[1];
      if (!range || "items" in range || range.op !== "between" || !Array.isArray(range.value))
        throw new Error("预期指标日期范围");
      const dates = { "v.visited_on": "visited_on", "v.registered_on": "registered_on" };
      const dateColumn = dates[range.field as keyof typeof dates];
      if (!dateColumn) throw new Error("日期字段不属于样本");
      const condition = query.from.filters?.items[0];
      if (
        !condition ||
        "items" in condition ||
        condition.field !== "v.department" ||
        condition.op !== "in" ||
        !Array.isArray(condition.value)
      )
        throw new Error("预期可信部门条件");
      const departments = condition.value;
      expect(query.from.filters?.logic).toBe("or");
      expect(query.from.filters?.items).toHaveLength(1);
      const grouped = query.group_by.length > 0;
      if (grouped) expect(query.group_by).toEqual(["v.department"]);
      const aggregates = query.select.filter((item) => item.aggregation);
      const ratio = aggregates.length === 2;
      expect(aggregates).toEqual(ratio ? ratioMetric.query.select : visitMetric.query.select);
      const result = await database.execute({
        sql: `SELECT ${grouped ? "department AS dimension_0," : ""} ${ratio ? "SUM(cost) AS numerator,SUM(units) AS denominator" : "COUNT(DISTINCT visit_id) AS value"} FROM dbo.acceptance_visits WHERE ${dateColumn} BETWEEN @start AND @end AND department IN (${departments.map((_, i) => `@dept${i}`).join(",")}) ${grouped ? "GROUP BY department ORDER BY department" : ""}`,
        parameters: [
          { name: "start", type: "string", value: String(range.value[0]) },
          { name: "end", type: "string", value: String(range.value[1]) },
          ...departments.map((value, i) => ({
            name: `dept${i}`,
            type: "string" as const,
            value: String(value),
          })),
        ],
      });
      return queryResultSchema.parse({
        columns: [
          ...(grouped ? [{ name: "dimension_0", data_type: "string" }] : []),
          ...aggregates.map((item) => ({ name: item.as, data_type: "integer" })),
        ],
        rows: result.rows,
        row_count: result.rows.length,
        truncated: false,
      });
    }
    async function execute(
      context: AuthContext,
      metric: MetricDefinition = visitMetric,
      start = "2026-09-01",
      end = "2026-09-30",
    ) {
      const conversation = await conversations.create(context);
      const message = await conversations.submitUserMessage(
        context,
        conversation.id,
        metric.name,
        randomUUID(),
      );
      const input = {
        analysis_run_id: message!.analysisRun.id,
        idempotency_key: "metric",
        start,
        end,
        dimensions: ["v.department"],
      };
      return { input, result: await metrics.execute(context, metric.metric_id, input) };
    }
    it("两种角色获得不同部门结果，跨组总计重新去重并复用重试证据", async () => {
      const all = await execute(full);
      const limited = await execute(restricted);
      expect(all.result.values).toEqual([2, 2]);
      expect(all.result.total).toBe(3);
      expect(limited.result.values).toEqual([2]);
      expect(limited.result.total).toBe(2);
      expect((await metrics.execute(full, visitMetric.metric_id, all.input)).evidence_ids).toEqual(
        all.result.evidence_ids,
      );
      expect((await runs.get(full, all.input.analysis_run_id)).status).toBe("completed");
    });
    it("总比率使用总分子除总分母，空范围返回 null", async () => {
      const all = await execute(full, ratioMetric);
      expect(all.result.values).toEqual([20, 9]);
      expect(all.result.total).toBeCloseTo(130 / 12);
      expect(
        (await execute(full, ratioMetric, "2027-01-01", "2027-01-01")).result.total,
      ).toBeNull();
    });
    it("指标工具交付时间要求，修正参数后查询 SQL 并持久化具体错误及两份证据", async () => {
      const conversation = await conversations.create(full);
      const submitted = await conversations.submitUserMessage(
        full,
        conversation.id,
        "九月各科室就诊人次",
        randomUUID(),
      );
      const runId = submitted!.analysisRun.id;
      const lease = await runs.claim(full, runId, "metric-tool-test");
      const tools = new AnalysisTools({
        runs,
        catalog,
        metrics,
        reports,
        listSourceIds: async () => ["clinical"],
        refreshContext: async (current) => ({
          ...current,
          ...(await auth.loadAuthorization(current.userId)),
        }),
      });
      const detail = await tools.execute(
        full,
        runId,
        lease,
        "describe_metric",
        { metric_id: "visit_count", version: 1 },
        "describe",
      );
      expect(detail).toMatchObject({
        success: true,
        output: {
          query_requirements: { time_format: "YYYY-MM-DD", allowed_dimensions: ["v.department"] },
        },
      });
      expect(
        await tools.execute(
          full,
          runId,
          lease,
          "query_metric",
          {
            metric_id: "visit_count",
            version: 1,
            start: "2026-09-01 00:00:00",
            end: "2026-09-30 23:59:59",
            dimensions: ["v.department"],
          },
          "invalid",
        ),
      ).toMatchObject({
        success: false,
        output: {
          code: "INVALID_INPUT",
          message: expect.stringContaining("start 必须匹配指标的 date 格式 YYYY-MM-DD"),
        },
      });
      expect(await runs.evidence(full, runId)).toEqual([]);
      const input = {
        metric_id: "visit_count",
        version: 1,
        start: "2026-09-01",
        end: "2026-09-30",
        dimensions: ["v.department"],
      };
      const corrected = await tools.execute(full, runId, lease, "query_metric", input, "corrected");
      expect(corrected).toMatchObject({
        success: true,
        output: {
          values: [2, 2],
          total: 3,
          evidence_ids: [expect.any(String), expect.any(String)],
        },
      });
      expect(await tools.execute(full, runId, lease, "query_metric", input, "retry")).toEqual(
        corrected,
      );
      expect(await runs.evidence(full, runId)).toHaveLength(2);
      const audits = await database.execute({
        sql: "SELECT audit_json FROM dbo.analysis_tool_audits WHERE analysis_run_id=@run",
        parameters: [{ name: "run", type: "string", value: runId }],
      });
      expect(audits.rows.map((row) => JSON.parse(String(row.audit_json)))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool_name: "query_metric",
            status: "failed",
            output_summary: expect.stringContaining("start 必须匹配指标的 date 格式 YYYY-MM-DD"),
          }),
          expect.objectContaining({
            tool_name: "query_metric",
            status: "completed",
            evidence_ids: [expect.any(String), expect.any(String)],
          }),
        ]),
      );
      await runs.complete(full, runId, lease, "指标工具修正后查询完成");
    });
    it("日期依据使用独立指标标识，版本不可覆盖且重试固定原版本", async () => {
      const initial = await execute(full);
      await expect(
        publishMetric({ ...visitMetric, name: "相同版本的其他内容" }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        publishMetric({
          ...visitMetric,
          version: 2,
          date_basis: { field: "v.registered_on", data_type: "date" },
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const registered = metricDefinitionSchema.parse({
        ...visitMetric,
        metric_id: "registered_count",
        date_basis: { field: "v.registered_on", data_type: "date" },
      });
      await publishMetric(registered);
      expect((await execute(full, registered)).result.total).toBe(2);
      await publishMetric({ ...visitMetric, version: 2, name: "新版就诊人次" });
      expect((await metrics.execute(full, visitMetric.metric_id, initial.input)).version).toBe(1);
    });
    it("报告快照经过分享和当前范围双重校验，撤回分享同时作用于历史版本", async () => {
      const { input, result } = await execute(full);
      const request = {
        analysis_run_id: input.analysis_run_id,
        title: "就诊分析",
        shared_with: [restricted.userId],
        sections: [
          {
            section_id: "s",
            title: "统计",
            blocks: [
              {
                block_id: "b",
                type: "table",
                title: "就诊人次",
                evidence_ids: result.evidence_ids,
              },
            ],
          },
        ],
      };
      const saved = await reports.save(full, request);
      expect((await reports.get(full, saved.report_id)).sources).toHaveLength(2);
      await expect(reports.get(restricted, saved.report_id)).rejects.toMatchObject({
        code: "POLICY_REJECTED",
      });
      const equalScope = { ...restricted, permissionContext: full.permissionContext };
      expect((await reports.get(equalScope, saved.report_id)).version).toBe(1);
      await reports.save(full, { ...request, shared_with: [] }, saved.report_id, 1);
      await expect(reports.get(equalScope, saved.report_id, 1)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(reports.save(full, request, saved.report_id, 1)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });
    it("部门收回后拒绝读取历史运行、SSE 和证据", async () => {
      const { input } = await execute(full);
      await auth.updateUserDepartments(full.userId, "org", ["A"]);
      const changed = { ...full, ...(await auth.loadAuthorization(full.userId)) };
      await expect(runs.get(changed, input.analysis_run_id)).rejects.toMatchObject({
        code: "POLICY_REJECTED",
      });
      await expect(runs.events(changed, input.analysis_run_id, 0)).rejects.toMatchObject({
        code: "POLICY_REJECTED",
      });
      await expect(runs.evidence(changed, input.analysis_run_id)).rejects.toMatchObject({
        code: "POLICY_REJECTED",
      });
    });
  });
}
export { registerBusinessAcceptance };
