import { describe, expect, it } from "vitest";
import { reportDefinitionSchema } from "@ai-data/contracts";
import { parameterDrafts, readParameters } from "../../../src/features/reports/models/parameters";

const definition = reportDefinitionSchema.parse({
  title: "参数验收",
  parameters: [
    { name: "flag", label: "包含停用", data_type: "boolean" },
    { name: "count", label: "下限", data_type: "integer", min: 0, max: 10 },
    { name: "text", label: "文本", data_type: "string", required: false },
    { name: "date", label: "日期", data_type: "date", default_value: "2026-09-01" },
    { name: "ids", label: "多个编号", data_type: "integer", required: false },
  ],
  queries: [
    {
      query_id: "q",
      query: {
        type: "relational_query",
        source_id: "s",
        from: { object_id: "t", alias: "t" },
        select: [{ field: "t.id" }],
      },
      bindings: [{ parameter: "ids", target: { type: "filter", field: "t.id", op: "in" } }],
    },
  ],
  presentation: [
    {
      section_id: "s",
      title: "数据",
      blocks: [{ block_id: "b", type: "table", title: "结果", query_ids: ["q"] }],
    },
  ],
});

describe("报表参数的业务取值", () => {
  it("范围必须成对且有序，相对日期默认值由 API 决定", () => {
    const input = structuredClone(definition);
    input.parameters = [
      {
        name: "ids",
        label: "日期范围",
        data_type: "date",
        required: true,
        relative_time: {
          range: { type: "relative", period: "this_year", extent: "full_period" },
          part: "range",
        },
      },
    ];
    input.queries[0]!.bindings[0]!.target = {
      type: "filter",
      field: "t.id",
      op: "between",
      scope: "query",
    };
    expect(readParameters(input, parameterDrafts(input))).toEqual({});
    expect(
      readParameters(input, { ids: { mode: "value", raw: "2026-01-01\n2026-12-31" } }),
    ).toEqual({ ids: ["2026-01-01", "2026-12-31"] });
    expect(() =>
      readParameters(input, { ids: { mode: "value", raw: "2026-12-31\n2026-01-01" } }),
    ).toThrow("日期范围");
  });
  it("必填值尚未输入时拒绝执行，默认值留给服务端解析", () => {
    const drafts = parameterDrafts(definition);
    expect(() => readParameters(definition, drafts)).toThrow("包含停用");
    drafts.flag = { mode: "value", raw: "false" };
    drafts.count = { mode: "value", raw: "0" };
    expect(readParameters(definition, drafts)).toEqual({ flag: false, count: 0 });
  });
  it("空字符串、显式空值、未覆盖以及多值保持独立语义", () => {
    const drafts = parameterDrafts(definition);
    drafts.flag = { mode: "value", raw: "false" };
    drafts.count = { mode: "value", raw: "0" };
    drafts.text = { mode: "value", raw: "" };
    drafts.ids = { mode: "value", raw: "1\n2\n3" };
    expect(readParameters(definition, drafts)).toEqual({
      flag: false,
      count: 0,
      text: "",
      ids: [1, 2, 3],
    });
    drafts.text.mode = "null";
    expect(readParameters(definition, drafts).text).toBeNull();
  });
  it("拒绝非法日期、小数整数、越界数值及不合法 Base64", () => {
    const drafts = parameterDrafts(definition);
    drafts.flag = { mode: "value", raw: "true" };
    drafts.count = { mode: "value", raw: "1.5" };
    expect(() => readParameters(definition, drafts)).toThrow("下限");
    drafts.count.raw = "11";
    expect(() => readParameters(definition, drafts)).toThrow("下限");
    drafts.count.raw = "1";
    drafts.date = { mode: "value", raw: "2026-02-30" };
    expect(() => readParameters(definition, drafts)).toThrow("日期");
    const binary = structuredClone(definition);
    binary.parameters = [{ name: "data", label: "附件", data_type: "buffer", required: true }];
    expect(() => readParameters(binary, { data: { mode: "value", raw: "bad!" } })).toThrow("附件");
  });
});
