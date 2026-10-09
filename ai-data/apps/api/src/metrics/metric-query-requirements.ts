import type { MetricDefinition } from "@ai-data/contracts";

/** 指标沿用项目日期合同，格式说明与指标时间类型校验共用同一映射。 */
const metricTimeFormats = { date: "YYYY-MM-DD", datetime: "YYYY-MM-DD HH:mm:ss" } as const;

/** 在指标授权通过后生成调用要求；示例只演示格式，实际范围由当前问题确定。 */
function metricQueryRequirements(metric: MetricDefinition) {
  const datetime = metric.date_basis.data_type === "datetime";
  return {
    time_format: metricTimeFormats[metric.date_basis.data_type],
    timezone: "UTC+8",
    range_bounds: "inclusive",
    allowed_dimensions: metric.dimensions,
    example_note: "示例仅演示参数格式，start/end 请使用当前用户要求的时间范围。",
    example: {
      metric_id: metric.metric_id,
      version: metric.version,
      start: datetime ? "2026-01-01 00:00:00" : "2026-01-01",
      end: datetime ? "2026-01-31 23:59:59" : "2026-01-31",
      dimensions: metric.dimensions.slice(0, 1),
    },
  };
}

export { metricTimeFormats, metricQueryRequirements };
