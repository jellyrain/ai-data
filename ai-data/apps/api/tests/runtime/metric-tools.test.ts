import { describe, expect, it, vi } from "vitest";
import {
  metricDefinitionSchema,
  queryEvidenceSchema,
  relationalQuerySchema,
  type MetricDefinition,
} from "@ai-data/contracts";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { MetricService } from "../../src/metrics/metric-service";
import { ApplicationError } from "../../src/errors/application-error";
import type { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { context, createApiDependencies } from "../support/api-fixtures";

function setup(dataType: "date" | "datetime" = "datetime", dimensions = ["v.department"]) {
  const metric = metricDefinitionSchema.parse({
    metric_id: "visits",
    version: 1,
    name: "就诊人次",
    description: "按就诊时间去重",
    aliases: [],
    grain: "就诊",
    deduplication_keys: ["v.id"],
    date_basis: { field: "v.visited_at", data_type: dataType },
    dimensions,
    total_rule: "recalculate",
    value: { type: "column", column: "value" },
    query: {
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visits", alias: "v" },
      select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
    },
  });
  const repository = {
    find: vi.fn(async (): Promise<MetricDefinition | null> => metric),
    list: vi.fn(async () => [metric]),
    findPublicationScope: vi.fn(async () => ({ source_id: "clinical", metric_id: "visits" })),
  };
  const authorization = { authorize: vi.fn(async () => ({})) };
  const runs = {
    assertCurrent: vi.fn(async () => {}),
    recordTool: vi.fn(async () => {}),
    evidence: vi.fn(async () => []),
    query: vi.fn<AnalysisRunService["query"]>(
      async (_context, runId, _lease, key, query, reference) => {
        const grouped = relationalQuerySchema
          .parse(query)
          .select.some((column) => column.as === "dimension_0");
        return queryEvidenceSchema.parse({
          evidence_id: `e-${key}`,
          tool_call_id: key,
          analysis_run_id: runId,
          organization_id: context.organizationId,
          user_id: context.userId,
          created_at: "2026-10-08 10:00:00",
          requested_query: query,
          authorized_query: query,
          output_masks: [],
          metric: reference,
          result: {
            columns: [
              ...(grouped ? [{ name: "dimension_0", data_type: "string" }] : []),
              { name: "value", data_type: "integer" },
            ],
            rows: [grouped ? { dimension_0: "A", value: 2 } : { value: 2 }],
            row_count: 1,
            truncated: false,
          },
        });
      },
    ),
  };
  const metrics = new MetricService(
    repository,
    authorization as unknown as ConstructorParameters<typeof MetricService>[1],
    runs as unknown as AnalysisRunService,
  );
  const api = createApiDependencies();
  const service = new AnalysisTools({
    runs,
    metrics,
    catalog: api.catalog.service,
    reports: api.analysis.reports,
    listSourceIds: async () => ["clinical"],
    refreshContext: api.auth.refreshContext,
  } as unknown as ConstructorParameters<typeof AnalysisTools>[0]);
  const lease = { owner: "worker", epoch: 1, expires_at: "2026-10-08 23:00:00" };
  const execute = (name: string, input: unknown, id = "call") =>
    service.execute(context, "run", lease, name, input, id);
  return { metric, repository, authorization, runs, service, execute };
}
const input = {
  metric_id: "visits",
  version: 1,
  start: "2026-08-01 00:00:00",
  end: "2026-08-31 23:59:59",
  dimensions: ["v.department"],
};

describe("指标工具的格式要求与修正提示", () => {
  it("工具定义明确时间格式、固定时间依据和维度来源", () => {
    const definition = setup()
      .service.definitions()
      .find((tool) => tool.name === "query_metric")!;
    const schema = definition.inputSchema as {
      properties: Record<string, { description: string }>;
    };
    for (const field of ["start", "end"]) {
      expect(schema.properties[field]!.description).toContain("YYYY-MM-DD HH:mm:ss");
      expect(schema.properties[field]!.description).toContain("date_basis.data_type");
      expect(schema.properties[field]!.description).toContain("UTC+8");
    }
    expect(schema.properties.dimensions!.description).toContain("describe_metric");
  });
  it.each(["date", "datetime"] as const)(
    "%s 指标详情交付实际格式和可执行示例",
    async (dataType) => {
      const h = setup(dataType);
      const detail = await h.execute("describe_metric", { metric_id: "visits" });
      expect(detail).toMatchObject({
        success: true,
        output: {
          query_requirements: {
            time_format: dataType === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm:ss",
            timezone: "UTC+8",
            range_bounds: "inclusive",
            allowed_dimensions: ["v.department"],
            example_note: expect.stringContaining("用户"),
          },
        },
      });
      const example = (detail.output as { query_requirements: { example: unknown } })
        .query_requirements.example;
      expect(await h.execute("query_metric", example)).toMatchObject({
        success: true,
        output: { total: 2 },
      });
      expect(h.runs.query).toHaveBeenCalledTimes(2);
      for (const call of h.runs.query.mock.calls)
        expect(relationalQuerySchema.parse(call[4]).filters).toMatchObject({
          items: expect.arrayContaining([
            {
              field: "v.visited_at",
              data_type: dataType,
              op: "between",
              value: [expect.any(String), expect.any(String)],
            },
          ]),
        });
    },
  );
  it("无已发布维度的指标用空数组示例查询", async () => {
    const h = setup("datetime", []);
    expect(await h.execute("describe_metric", { metric_id: "visits" })).toMatchObject({
      output: {
        query_requirements: { allowed_dimensions: [], example: { dimensions: [] } },
      },
    });
  });
  it("无指标权限时拒绝详情及调用要求", async () => {
    const h = setup();
    h.authorization.authorize.mockRejectedValue(
      new ApplicationError("UNAUTHORIZED_COLUMN", "无权读取指标列"),
    );
    const result = await h.execute("describe_metric", { metric_id: "visits" });
    expect(result).toMatchObject({ success: false, output: { code: "UNAUTHORIZED_COLUMN" } });
    expect(result.output).not.toHaveProperty("query_requirements");
  });
  it("日期传给 datetime 指标时明确要求，修正后成功且保留输入时间范围", async () => {
    const h = setup();
    const failed = await h.execute(
      "query_metric",
      { ...input, start: "2026-08-01", end: "2026-08-31" },
      "first",
    );
    expect(failed).toMatchObject({
      success: false,
      output: { message: expect.stringContaining("start"), code: "INVALID_INPUT" },
    });
    expect((failed.output as { message: string }).message).toContain("YYYY-MM-DD HH:mm:ss");
    expect(h.runs.query).not.toHaveBeenCalled();
    expect(h.runs.recordTool).toHaveBeenLastCalledWith(
      context,
      "run",
      expect.anything(),
      expect.objectContaining({
        status: "failed",
        output_summary: expect.stringContaining("YYYY-MM-DD HH:mm:ss"),
      }),
    );
    expect(await h.execute("query_metric", input, "corrected")).toMatchObject({
      success: true,
      output: { total: 2 },
    });
    expect(h.runs.query).toHaveBeenCalledTimes(2);
    for (const call of h.runs.query.mock.calls)
      expect(JSON.stringify(relationalQuerySchema.parse(call[4]).filters)).toContain(input.end);
  });
  it("datetime 传给 date 指标时提示日期要求", async () => {
    const result = await setup("date").execute("query_metric", input);
    expect(result).toMatchObject({
      success: false,
      output: { message: expect.stringContaining("date 格式 YYYY-MM-DD") },
    });
  });
  it.each(["2026-01-01T00:00:00", "2026-01", "2026-02-30 00:00:00", "2026-01-01\n其他文本"])(
    "无效 start=%s 的具体格式错误交付模型和审计",
    async (start) => {
      const h = setup();
      const result = await h.execute("query_metric", { ...input, start });
      expect(result).toMatchObject({
        success: false,
        output: {
          code: "INVALID_INPUT",
          message: expect.stringContaining("start"),
          issues: [
            expect.objectContaining({
              path: "start",
              message: expect.stringContaining("YYYY-MM-DD HH:mm:ss"),
            }),
          ],
        },
      });
      expect(h.runs.query).not.toHaveBeenCalled();
      expect(h.runs.recordTool).toHaveBeenLastCalledWith(
        context,
        "run",
        expect.anything(),
        expect.objectContaining({
          output_summary: expect.stringContaining("start："),
        }),
      );
    },
  );
  it.each([
    [{ ...input, end: "2026-08-31T23:59:59" }, "end", "YYYY-MM-DD HH:mm:ss"],
    [{ ...input, end: "2026-08-31" }, "end", "相同"],
    [{ ...input, end: "2026-07-31 23:59:59" }, "end", "不能早于"],
  ])("终点格式和范围错误明确定位到 end", async (value, field, message) => {
    const result = await setup().execute("query_metric", value);
    expect(result).toMatchObject({
      success: false,
      output: {
        issues: [
          expect.objectContaining({ path: field, message: expect.stringContaining(message) }),
        ],
      },
    });
  });
  it.each([
    [["v.missing"], "已发布维度"],
    [["v.department", "v.department"], "重复"],
  ])("维度错误区别于时间错误", async (dimensions, message) => {
    const h = setup();
    const result = await h.execute("query_metric", { ...input, dimensions });
    expect(result).toMatchObject({
      success: false,
      output: { message: expect.stringContaining(message), code: "INVALID_INPUT" },
    });
    expect((result.output as { message: string }).message).toContain("dimensions");
    expect(h.runs.query).not.toHaveBeenCalled();
  });
  it("未知身份字段仍在查询前拒绝", async () => {
    const h = setup();
    expect(await h.execute("query_metric", { ...input, user_id: "other" })).toMatchObject({
      success: false,
      output: { code: "INVALID_INPUT" },
    });
    expect(h.runs.query).not.toHaveBeenCalled();
  });
});
