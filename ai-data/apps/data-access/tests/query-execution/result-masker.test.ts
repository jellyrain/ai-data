import { describe, expect, it } from "vitest";

import { applyOutputMasks } from "../../src/query-execution/result-masker";

describe("查询结果脱敏", () => {
  // BDD 场景：API 对手机号列签发部分脱敏规则；TDD 断言：DAS 只处理对应字符串结果列并保留空值。
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
