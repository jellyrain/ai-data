import { describe, expect, it } from "vitest";
import { relationalQuerySchema, catalogRelationSchema } from "@ai-data/contracts";
import {
  metricQueryToEditor,
  editorQueryToMetric,
} from "../../../src/features/knowledge/stores/metric-query-editing";

describe("指标与报表关系编辑转换", () => {
  it("保留批准关联的固定字段对和左连接预过滤", () => {
    const relation = catalogRelationSchema.parse({
      relation_id: "visit_charge",
      source_id: "demo",
      object_id: "visits",
      target_object_id: "charges",
      description: "费用",
      version: 1,
      updated_at: "2026-10-03 10:00:00",
      column_pairs: [{ source_column: "id", target_column: "visit_id" }],
      cardinality: "one_to_many",
      allowed_join_types: ["left"],
      enabled: true,
    });
    const query = relationalQuerySchema.parse({
      type: "relational_query",
      source_id: "demo",
      from: { object_id: "visits", alias: "v" },
      select: [{ field: "v.id", aggregation: "count_distinct", as: "count" }],
      joins: [
        {
          type: "left",
          object_id: "charges",
          alias: "c",
          relation_id: relation.relation_id,
          on: [{ left: "v.id", op: "eq", right: "c.visit_id" }],
          filters: {
            logic: "and",
            items: [{ field: "c.valid", data_type: "boolean", op: "eq", value: true }],
          },
        },
      ],
    });
    const edited = metricQueryToEditor(query, [relation]);
    expect(edited.joins[0]).toMatchObject({ source_alias: "v", relation_id: "visit_charge" });
    expect(editorQueryToMetric(edited, [relation])).toEqual(query);
    expect(() => metricQueryToEditor(query, [])).toThrow();
    expect(() => editorQueryToMetric(edited, [{ ...relation, enabled: false }])).toThrow();
  });
});
