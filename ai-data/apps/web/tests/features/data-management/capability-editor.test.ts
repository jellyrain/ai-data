import { describe, expect, it } from "vitest";
import { datasetSchema, type QueryCapabilities } from "@ai-data/contracts";
import {
  capabilityMode,
  changeCapabilityMode,
  selectCapabilityFields,
  capabilityFields,
  validateCapabilities,
  validateParameterSettings,
} from "../../../src/features/data-management/stores/capability-editor";

const dataset = datasetSchema.parse({
  source_id: "hdr",
  object_id: "view.dbo.明细",
  name: "明细",
  kind: "table",
  columns: [
    { name: "科室", data_type: "string", nullable: false },
    { name: "金额$", data_type: "decimal", nullable: false },
    { name: "__$operation", data_type: "integer", nullable: false },
  ],
});

describe("查询能力可视化草稿", () => {
  it("默认和禁用分别保存为省略和空数组，切换不影响其他能力", () => {
    const old: QueryCapabilities = { sortable_fields: [], groupable_fields: ["科室"] };
    expect(capabilityMode(old, "sortable_fields")).toBe("disabled");
    expect(capabilityMode(old, "filter_conditions")).toBe("default");
    expect(changeCapabilityMode(old, "sortable_fields", "default")).toEqual({
      groupable_fields: ["科室"],
    });
    expect(changeCapabilityMode(undefined, "aggregations", "disabled")).toEqual({
      aggregations: [],
    });
    expect(
      changeCapabilityMode({ sortable_fields: [] }, "sortable_fields", "default"),
    ).toBeUndefined();
    expect(old.sortable_fields).toEqual([]);
  });
  it("选择字段保留已有筛选约束和默认值，新字段自动带入真实类型", () => {
    const old: QueryCapabilities = {
      filter_conditions: [
        {
          name: "科室",
          data_type: "string",
          allowed_ops: ["eq"],
          required: true,
          default_value: "内科",
          source_description: "范围",
        },
      ],
    };
    const next = selectCapabilityFields(
      old,
      "filter_conditions",
      ["科室", "__$operation"],
      dataset.columns,
    );
    expect(next.filter_conditions?.[0]).toEqual(old.filter_conditions?.[0]);
    expect(next.filter_conditions?.[1]).toMatchObject({
      name: "__$operation",
      data_type: "integer",
      required: false,
    });
    expect(
      selectCapabilityFields(next, "filter_conditions", ["__$operation"], dataset.columns)
        .filter_conditions,
    ).toHaveLength(1);
  });
  it("业务能力只能选择源能力范围，新字段继承源的操作约束", () => {
    const base: QueryCapabilities = {
      sortable_fields: [],
      filter_conditions: [
        {
          name: "科室",
          data_type: "string",
          allowed_ops: ["eq"],
          required: true,
          default_value: "内科",
        },
      ],
    };
    expect(capabilityFields(dataset.columns, "sortable_fields", base)).toEqual([]);
    expect(capabilityFields(dataset.columns, "filter_conditions", base).map((c) => c.name)).toEqual(
      ["科室"],
    );
    expect(
      selectCapabilityFields(undefined, "filter_conditions", ["科室"], dataset.columns, base)
        .filter_conditions,
    ).toEqual(base.filter_conditions);
    expect(() =>
      validateCapabilities({ sortable_fields: ["科室"] }, dataset.columns, base),
    ).toThrow("源能力");
  });
  it("统计选项依据数值和文本类型提供，不扩大已有函数范围", () => {
    const next = selectCapabilityFields(
      undefined,
      "aggregations",
      ["科室", "金额$"],
      dataset.columns,
    );
    expect(next.aggregations?.[0]?.functions).not.toContain("sum");
    expect(next.aggregations?.[1]?.functions).toContain("sum");
    expect(() =>
      validateCapabilities(
        { aggregations: [{ field: "科室", functions: ["sum"] }] },
        dataset.columns,
      ),
    ).toThrow("统计");
  });
  it("缺失字段和错误类型原样保留以便修正，保存时明确拒绝", () => {
    expect(() => validateCapabilities({ sortable_fields: ["已删除"] }, dataset.columns)).toThrow(
      "已删除",
    );
    expect(() =>
      validateCapabilities(
        {
          filter_conditions: [
            {
              name: "金额$",
              data_type: "decimal",
              allowed_ops: ["eq"],
              required: false,
              default_value: "abc",
            },
          ],
        },
        dataset.columns,
      ),
    ).toThrow();
  });
});

describe("业务参数和权限绑定", () => {
  const parameterized = datasetSchema.parse({
    ...dataset,
    kind: "stored_procedure",
    query_parameters: [
      {
        name: "科室参数",
        data_type: "string",
        allowed_ops: ["eq"],
        required: true,
        default_value: "内科",
      },
      { name: "金额参数", data_type: "decimal", allowed_ops: ["eq"], required: false },
    ],
  });
  it("保留 false、零、空值及省略值的不同含义", () => {
    expect(() =>
      validateParameterSettings(
        parameterized,
        [{ name: "金额参数", required: false, default_value: 0 }],
        [{ field: "金额$", parameter: "金额参数", operator: "eq" }],
      ),
    ).not.toThrow();
    expect(() =>
      validateParameterSettings(
        parameterized,
        [{ name: "金额参数", default_value: null }],
        undefined,
      ),
    ).not.toThrow();
  });
  it.each([
    [{ name: "科室参数", required: false }],
    [{ name: "科室参数", allowed_ops: ["between"] }],
    [{ name: "不存在" }],
    [{ name: "金额参数", default_value: "abc" }],
  ])("拒绝放宽参数、引用缺失参数和错误默认值 %j", (...policies) => {
    expect(() => validateParameterSettings(parameterized, policies, undefined)).toThrow();
  });
  it("绑定限定为类型相同且支持等值的字段和参数，并禁止重复", () => {
    expect(() =>
      validateParameterSettings(parameterized, undefined, [
        { field: "科室", parameter: "金额参数", operator: "eq" },
      ]),
    ).toThrow("类型");
    expect(() =>
      validateParameterSettings(dataset, undefined, [
        { field: "科室", parameter: "科室参数", operator: "eq" },
      ]),
    ).toThrow("参数化");
    expect(() =>
      validateParameterSettings(parameterized, undefined, [
        { field: "科室", parameter: "科室参数", operator: "eq" },
        { field: "科室", parameter: "科室参数", operator: "eq" },
      ]),
    ).toThrow("重复");
  });
});
