import { describe, expect, it } from "vitest";
import type { Dataset, MetricDefinition, PublishedKnowledge } from "@ai-data/contracts";
import {
  datasetSummary,
  metricSummary,
  knowledgeSummary,
  discoveryPage,
} from "../../src/runtime/model-discovery-result";

describe("模型目录发现结果", () => {
  it("数据集摘要包含对象类型和查询能力，字段与参数通过详情读取", () => {
    const dataset = {
      source_id: "s",
      object_id: "payment",
      name: "支付流水",
      kind: "table",
      source_description: "现金支付",
      columns: [{ name: "private_field" }],
      query_parameters: [{ name: "parameter" }],
      query_capabilities: { supports_relational_query: true },
    } as unknown as Dataset;
    expect(datasetSummary(dataset)).toMatchObject({
      object_id: "payment",
      kind: "table",
      source_description: "现金支付",
    });
    expect(datasetSummary(dataset)).not.toHaveProperty("columns");
    expect(datasetSummary(dataset)).not.toHaveProperty("query_parameters");
  });
  it("指标和知识索引保留定位信息，正文及完整查询不进入列表", () => {
    const metric = {
      metric_id: "fee",
      version: 2,
      name: "费用",
      description: "按支付日期",
      date_basis: { field: "p.paid_at", data_type: "datetime" },
      query: { source_id: "s", from: { object_id: "payment" }, select: ["SECRET_DSL"] },
    } as unknown as MetricDefinition;
    const knowledge = {
      knowledge_id: "k",
      version: 2,
      content: { type: "metric", definition: metric },
      scope: { source_id: "s" },
    } as unknown as PublishedKnowledge;
    expect(metricSummary(metric)).toMatchObject({
      metric_id: "fee",
      version: 2,
      source_id: "s",
      date_basis: metric.date_basis,
    });
    expect(JSON.stringify(metricSummary(metric))).not.toContain("SECRET_DSL");
    expect(knowledgeSummary(knowledge)).toEqual({
      knowledge_id: "k",
      version: 2,
      type: "metric",
      name: "费用",
      scope: { source_id: "s" },
    });
  });
  it("多关键词匹配摘要，稳定分页能够读到后一页", () => {
    const entries = [
      { id: "b", text: "支付流水 payment" },
      { id: "a", text: "门诊支付" },
      { id: "c", text: "住院" },
    ];
    const first = discoveryPage(
      entries,
      { query: "支付 payment", limit: 1 },
      (item) => item.id,
      (item) => item.text,
    );
    expect(first).toEqual({ items: [entries[0]], next_cursor: "1" });
    expect(
      discoveryPage(
        entries,
        { query: "支付 payment", limit: 1, cursor: first.next_cursor },
        (item) => item.id,
        (item) => item.text,
      ),
    ).toEqual({ items: [entries[1]] });
  });
});
