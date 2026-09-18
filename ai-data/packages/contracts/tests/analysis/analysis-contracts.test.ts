import { describe, expect, it } from "vitest";
import {
  submitMessageSchema,
  clarificationAnswerSchema,
  metricDefinitionSchema,
  savedReportSchema,
  analysisRunSchema,
} from "../../src/index";

describe("分析运行和业务合同", () => {
  it("消息提交必须提供稳定幂等键", () => {
    expect(submitMessageSchema.safeParse({ content: "查询人次" }).success).toBe(false);
    expect(
      submitMessageSchema.parse({ content: "查询人次", idempotency_key: "request-1" }),
    ).toEqual({ content: "查询人次", idempotency_key: "request-1" });
  });
  it("澄清回答只能选择选项或提交自定义回答之一", () => {
    const base = { clarification_id: "question-1", idempotency_key: "answer-1" };
    expect(clarificationAnswerSchema.safeParse(base).success).toBe(false);
    expect(
      clarificationAnswerSchema.safeParse({ ...base, option_id: "a", custom_input: "b" }).success,
    ).toBe(false);
    expect(clarificationAnswerSchema.safeParse({ ...base, option_id: "a" }).success).toBe(true);
  });
  it("指标固定日期依据，输出字段与统计定义一致", () => {
    const metric = {
      metric_id: "visits",
      version: 1,
      name: "就诊人次",
      description: "按就诊日期统计",
      aliases: ["人次"],
      grain: "就诊",
      deduplication_keys: ["v.id"],
      date_basis: { field: "v.visited_on", data_type: "date" },
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
      },
      dimensions: ["v.department"],
      value: { type: "column", column: "value" },
      total_rule: "recalculate",
    };
    expect(metricDefinitionSchema.safeParse(metric).success).toBe(true);
    expect(
      metricDefinitionSchema.safeParse({ ...metric, value: { type: "column", column: "missing" } })
        .success,
    ).toBe(false);
    expect(
      metricDefinitionSchema.safeParse({
        ...metric,
        date_basis: { field: "unjoined.date", data_type: "date" },
      }).success,
    ).toBe(false);
  });
  it("报告必须关联证据和完整来源运行", () => {
    expect(
      savedReportSchema.safeParse({ report_id: "report", title: "报告", content: "结果" }).success,
    ).toBe(false);
  });
  it("运行状态拒绝缺少归属与执行代次的信息", () => {
    expect(analysisRunSchema.safeParse({ analysis_run_id: "run", status: "running" }).success).toBe(
      false,
    );
  });
});
