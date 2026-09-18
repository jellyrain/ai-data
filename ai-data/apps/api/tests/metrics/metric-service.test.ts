import { describe, expect, it } from "vitest";
import { metricDefinitionSchema } from "@ai-data/contracts";
import { buildMetricQueries, calculateMetricValue } from "../../src/metrics/metric-service";

const metric = metricDefinitionSchema.parse({
  metric_id: "visits",
  version: 1,
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
    from: { object_id: "visit", alias: "v" },
    select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
  },
});
describe("指标时间口径和总计", () => {
  it("分组与总计固定相同时间字段，跨组去重总计独立重算", () => {
    const { grouped, total } = buildMetricQueries(metric, {
      analysis_run_id: "run",
      idempotency_key: "query",
      start: "2026-09-01",
      end: "2026-09-30",
      dimensions: ["v.department"],
    });
    expect(grouped.group_by).toEqual(["v.department"]);
    expect(total.group_by).toEqual([]);
    expect(total.select).toEqual([{ field: "v.id", aggregation: "count_distinct", as: "value" }]);
    expect(grouped.filters).toEqual(total.filters);
    expect(JSON.stringify(total.filters)).toContain("v.visited_on");
  });
  it("不能提交未发布维度或错误时间类型", () => {
    const input = {
      analysis_run_id: "run",
      idempotency_key: "query",
      start: "2026-09-01",
      end: "2026-09-30",
      dimensions: ["v.secret"],
    };
    expect(() => buildMetricQueries(metric, input)).toThrow();
    expect(() =>
      buildMetricQueries(metric, {
        ...input,
        dimensions: [],
        start: "2026-09-01 00:00:00",
        end: "2026-09-30 23:59:59",
      }),
    ).toThrow();
  });
  it("比率采用总分子除总分母，零分母返回 null", () => {
    const ratio = { type: "ratio" as const, numerator: "n", denominator: "d" };
    expect(calculateMetricValue({ n: 30, d: 10 }, ratio)).toBe(3);
    expect(calculateMetricValue({ n: 30, d: 0 }, ratio)).toBeNull();
    expect(() => calculateMetricValue({ n: "30", d: 10 }, ratio)).toThrow();
  });
});
