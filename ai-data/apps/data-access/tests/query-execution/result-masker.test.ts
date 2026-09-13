import { describe, expect, it } from "vitest";

import { applyOutputMasks } from "../../src/query-execution/result-masker";

// 手机号使用保留前三位、后四位的规则；同一结果中同时放入空值和未配置规则的整数列。
describe("查询结果脱敏", () => {
  it.each([
    { scenario: "后缀为零", value: "13800138000", prefix: 3, suffix: 0, expected: "138********" },
    {
      scenario: "前后缀均为零",
      value: "13800138000",
      prefix: 0,
      suffix: 0,
      expected: "***********",
    },
    { scenario: "仅保留后缀", value: "13800138000", prefix: 0, suffix: 4, expected: "*******8000" },
    { scenario: "字符串短于保留长度", value: "138", prefix: 3, suffix: 4, expected: "***" },
    { scenario: "字符串等于保留长度", value: "1388000", prefix: 3, suffix: 4, expected: "*******" },
    { scenario: "后缀为零且字符串短于前缀", value: "13", prefix: 3, suffix: 0, expected: "**" },
    { scenario: "空字符串", value: "", prefix: 0, suffix: 0, expected: "" },
    { scenario: "空值", value: null, prefix: 3, suffix: 0, expected: null },
  ])("$scenario 时只返回允许保留的字符", ({ value, prefix, suffix, expected }) => {
    const result = applyOutputMasks(
      {
        columns: [{ name: "phone", data_type: "string" }],
        rows: [{ phone: value }],
        row_count: 1,
        truncated: false,
      },
      {
        output_masks: [
          {
            result_column: "phone",
            rule: {
              type: "partial_mask",
              prefix_length: prefix,
              suffix_length: suffix,
              mask_character: "*",
            },
          },
        ],
      },
    );

    expect(result.rows).toEqual([{ phone: expected }]);
  });

  it("按结果列别名逐行应用部分脱敏", () => {
    const result = applyOutputMasks(
      {
        columns: [
          { name: "patient_phone", data_type: "string" },
          { name: "visit_id", data_type: "integer" },
        ],
        rows: [
          { patient_phone: "13800138000", visit_id: 1 },
          { patient_phone: null, visit_id: 2 },
        ],
        row_count: 2,
        truncated: false,
      },
      {
        output_masks: [
          {
            result_column: "patient_phone",
            rule: { type: "partial_mask", prefix_length: 3, suffix_length: 4, mask_character: "*" },
          },
        ],
      },
    );

    expect(result.rows).toEqual([
      { patient_phone: "138****8000", visit_id: 1 },
      { patient_phone: null, visit_id: 2 },
    ]);
  });
});
