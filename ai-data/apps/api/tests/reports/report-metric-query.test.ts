import { describe, expect, it, vi } from "vitest";
import {
  metricDefinitionSchema,
  queryDslSchema,
  reportDefinitionSchema,
  savedReportSchema,
} from "@ai-data/contracts";
import { ReportQueryService } from "../../src/reports/report-query-service";
import { buildMetricQueries } from "../../src/metrics/metric-service";
import { context } from "../support/api-fixtures";

const metric = metricDefinitionSchema.parse({
  metric_id: "visits",
  version: 3,
  name: "就诊人次",
  description: "按就诊日期去重",
  aliases: [],
  grain: "就诊",
  deduplication_keys: ["v.id"],
  date_basis: { field: "v.visited_on", data_type: "date" },
  dimensions: ["v.department"],
  total_rule: "recalculate",
  value: { type: "column", column: "value" },
  query: {
    type: "relational_query",
    source_id: "clinical",
    from: { object_id: "visits", alias: "v" },
    select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
  },
});
const range = { start: "2026-09-01", end: "2026-09-30", dimensions: ["v.department"] };
const queries = buildMetricQueries(metric, {
  ...range,
  analysis_run_id: "run",
  idempotency_key: "metric",
});
const presentation = [
  {
    section_id: "s",
    title: "统计",
    blocks: [{ block_id: "b", type: "table", title: "统计", query_ids: ["q"] }],
  },
];
function setup() {
  const get = vi.fn(async () => metric);
  const service = new ReportQueryService({
    metrics: { get },
    authorization: {
      authorize: async (query: unknown) => ({ request: { query: queryDslSchema.parse(query) } }),
    },
    catalog: {
      getAuthorized: async () => ({
        dataset: { columns: [{ name: "department", data_type: "string" }] },
      }),
    },
  } as unknown as ConstructorParameters<typeof ReportQueryService>[0]);
  return { service, get };
}
function snapshot() {
  return savedReportSchema.parse({
    report_id: "report",
    version: 1,
    analysis_run_id: "run",
    organization_id: "org",
    user_id: "user",
    created_at: "2026-09-21 10:00:00",
    title: "指标分析",
    shared_with: [],
    sections: [
      {
        section_id: "s",
        title: "统计",
        blocks: [{ block_id: "b", type: "table", title: "统计", evidence_ids: ["e"] }],
      },
    ],
    sources: [
      {
        evidence_id: "e",
        tool_call_id: "t",
        analysis_run_id: "run",
        organization_id: "org",
        user_id: "user",
        created_at: "2026-09-21 10:00:00",
        requested_query: queries.grouped,
        authorized_query: queries.grouped,
        metric: { metric_id: metric.metric_id, version: metric.version },
        output_masks: [],
        result: {
          columns: [
            { name: "dimension_0", data_type: "string" },
            { name: "value", data_type: "integer" },
          ],
          rows: [],
          row_count: 0,
          truncated: false,
        },
      },
    ],
  });
}
describe("统一报表中的指标语义", () => {
  it("同一次构建的分组与总计固定同一指标版本，总计独立重算", async () => {
    const h = setup();
    const definition = reportDefinitionSchema.parse({
      title: "指标",
      presentation,
      queries: [
        {
          query_id: "q",
          query: { type: "metric_query", metric_id: "visits", output: "grouped", ...range },
        },
        {
          query_id: "total",
          query: { type: "metric_query", metric_id: "visits", output: "total", ...range },
        },
      ],
    });
    const built = await h.service.build(context, definition, {});
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(built.queries.map((q) => q.metric)).toEqual([
      { metric_id: "visits", version: 3 },
      { metric_id: "visits", version: 3 },
    ]);
    expect(built.queries[1].query).toMatchObject({ group_by: [], limit: 1 });
  });
  it("完成快照转为可编辑定义时保留固定指标版本、日期与维度", async () => {
    const h = setup();
    const definition = await h.service.fromSnapshot(context, snapshot());
    expect(definition.queries[0].query).toEqual({
      type: "metric_query",
      metric_id: "visits",
      version: 3,
      output: "grouped",
      ...range,
    });
  });
  it("证据声称的指标口径与实际请求不一致时拒绝提取", async () => {
    const h = setup();
    const input = snapshot();
    if (input.sources[0].requested_query.type === "relational_query")
      input.sources[0].requested_query.select = [
        { field: "v.id", aggregation: "sum", as: "value" },
      ];
    await expect(h.service.fromSnapshot(context, input)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });
});
