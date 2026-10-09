import { describe, expect, it } from "vitest";
import { toolInputSummary, toolOutputSummary } from "../../src/runtime/tool-presentation";

describe("工具展示摘要", () => {
  it("展示搜索条件、命中对象和字段，参数值与数据行保持在证据内", () => {
    expect(
      toolInputSummary("search_catalog", { source_id: "clinical", query: "科室", limit: 10 }),
    ).toContain("科室");
    expect(toolOutputSummary("list_sources", { items: [{ source_id: "clinical" }] })).toContain(
      "clinical",
    );
    expect(
      toolOutputSummary("describe_dataset", {
        dataset: {
          object_id: "departments",
          columns: [{ name: "department_id" }, { name: "name" }],
        },
      }),
    ).toContain("department_id");
    const query = toolInputSummary("query_dataset", {
      query: {
        source_id: "clinical",
        from: { object_id: "departments" },
        filters: { items: [{ field: "name", value: "private-value" }] },
        select: [{ field: "id" }],
      },
    });
    expect(query).toContain("departments");
    expect(query).not.toContain("private-value");
    const output = toolOutputSummary("query_dataset", {
      columns: [{ name: "id" }],
      row_count: 18,
      truncated: false,
      rows: [{ id: "private-row" }],
      evidence_id: "e",
    });
    expect(output).toContain("18");
    expect(output).not.toContain("private-row");
  });
  it("显示业务规则阻止查询及分页状态，限制摘要长度", () => {
    expect(
      toolOutputSummary("query_dataset", { status: "rules_required", business_rules: [{}, {}] }),
    ).toContain("2");
    expect(
      toolOutputSummary("search_catalog", {
        items: Array.from({ length: 100 }, (_, i) => ({
          object_id: `object-${i}`,
          name: "名".repeat(1000),
        })),
        next_cursor: "100",
      }).length,
    ).toBeLessThanOrEqual(4000);
    expect(
      toolInputSummary("save_user_preference", { key: "date", value: "secret" }),
    ).not.toContain("secret");
  });
});
