import { describe, expect, it } from "vitest";
import type { ReportParameter } from "@ai-data/contracts";
import {
  parameterDefaultLabel,
  parameterInputRaw,
  readParameters,
} from "../../../src/features/reports/models/parameters";

const parameter: ReportParameter = {
  name: "count",
  label: "人数",
  data_type: "integer",
  required: false,
};
describe("筛选条件直接输入与默认状态", () => {
  it("未覆盖时直接显示零、否和范围默认值，输入后显示本次值", () => {
    const draft = { mode: "default" as const, raw: "" };
    expect(parameterInputRaw({ ...parameter, default_value: 0 }, draft)).toBe("0");
    expect(
      parameterInputRaw({ ...parameter, data_type: "boolean", default_value: false }, draft),
    ).toBe("false");
    expect(parameterInputRaw({ ...parameter, default_value: [0, 10] }, draft)).toBe("0\n10");
    expect(
      parameterInputRaw({ ...parameter, default_value: 10 }, { mode: "value", raw: "0" }),
    ).toBe("0");
    expect(parameterInputRaw(parameter, { mode: "null", raw: "old" })).toBe("");
  });
  it("中文默认摘要区分未设置、空字符串和显式空值", () => {
    expect(parameterDefaultLabel(parameter)).toBe("未设置");
    expect(parameterDefaultLabel({ ...parameter, data_type: "string", default_value: "" })).toBe(
      "空字符串",
    );
    expect(parameterDefaultLabel({ ...parameter, default_value: null })).toBe("空值");
    expect(
      parameterDefaultLabel({ ...parameter, data_type: "boolean", default_value: false }),
    ).toBe("否");
  });
  it("相对日期显示业务含义并保持服务端动态解析", () => {
    const relative: ReportParameter = {
      ...parameter,
      data_type: "date",
      required: true,
      relative_time: {
        range: { type: "relative", period: "this_year", extent: "to_date" },
        part: "range",
      },
    };
    expect(parameterDefaultLabel(relative)).toBe("本年 · 截至当天");
    const draft = { mode: "default" as const, raw: "" };
    expect(parameterInputRaw(relative, draft)).toBe("");
    expect(
      readParameters(
        {
          title: "日期查询",
          parameters: [relative],
          queries: [],
          presentation: [],
          block_references: [],
        },
        { count: draft },
      ),
    ).toEqual({});
  });
});
