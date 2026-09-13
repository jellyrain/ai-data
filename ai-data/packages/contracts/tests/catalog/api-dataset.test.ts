import { describe, expect, it } from "vitest";

import { apiDatasetConfigSchema } from "../../src/catalog/api-dataset";

// 本组验证业务目录配置的结构；能力收窄与角色脱敏是否生效，需要结合运行时权限计算验证。
describe("API 数据集配置合同", () => {
  it("接受业务配置和批准的关联关系", () => {
    const result = apiDatasetConfigSchema.parse({
      source_id: "clinical",
      object_id: "clinical.outpatient_visit",
      business_description: "门诊就诊记录",
      grain: "一行代表一次门诊就诊",
      column_descriptions: [
        {
          field: "patient_phone",
          business_description: "患者联系手机号，用于联系患者，不代表就诊科室。",
        },
      ],
      approved_relations: [
        {
          target_object_id: "clinical.department",
          description: "按科室编码关联科室维度",
          column_pairs: [
            {
              source_column: "department_id",
              target_column: "id",
            },
          ],
        },
      ],
      query_parameter_policies: [
        {
          name: "department_id",
          allowed_ops: ["eq"],
          required: false,
          default_value: "ALL",
        },
      ],
      query_capabilities: {
        filter_conditions: [
          {
            name: "admission_date",
            data_type: "date",
            allowed_ops: ["between"],
            required: true,
          },
        ],
      },
      column_policies: [
        {
          field: "patient_phone",
          default_masking: { type: "partial_mask", prefix_length: 3, suffix_length: 4 },
          unmasked_role_ids: ["data_admin"],
        },
      ],
    });

    expect(result.approved_relations).toHaveLength(1);
    expect(result.query_parameter_policies?.[0]?.default_value).toBe("ALL");
    expect(result.approved_relations[0]?.column_pairs).toHaveLength(1);
    expect(result.column_descriptions[0]?.business_description).toContain("患者联系手机号");
    expect(result.column_policies[0]?.default_masking.type).toBe("partial_mask");
  });

  it("允许没有批准关联的业务配置", () => {
    const result = apiDatasetConfigSchema.parse({
      source_id: "sales",
      object_id: "sales.orders",
    });

    expect(result.approved_relations).toEqual([]);
    expect(result.column_descriptions).toEqual([]);
    expect(result.column_policies).toEqual([]);
  });

  it("接受管理员确认的字段到等值权限参数绑定", () => {
    const result = apiDatasetConfigSchema.parse({
      source_id: "clinical",
      object_id: "report",
      query_permission_bindings: [{ field: "dept", parameter: "department", operator: "eq" }],
    });
    expect(result).toMatchObject({
      query_permission_bindings: [{ field: "dept", parameter: "department", operator: "eq" }],
    });
  });

  it.each([
    [{ parameter: "department", operator: "eq" }],
    [{ field: "dept", operator: "eq" }],
    [{ field: "dept", parameter: "department" }],
    [{ field: "dept", parameter: "department", operator: "in" }],
    [{ field: "dept", parameter: "department", operator: "eq", trusted: true }],
    [{ field: "dept;DROP", parameter: "department", operator: "eq" }],
    [
      { field: "dept", parameter: "department", operator: "eq" },
      { field: "org", parameter: "department", operator: "eq" },
    ],
    [
      { field: "dept", parameter: "department", operator: "eq" },
      { field: "dept", parameter: "other", operator: "eq" },
    ],
  ])("拒绝不完整、无效或冲突的权限绑定 %j", (...query_permission_bindings) => {
    expect(
      apiDatasetConfigSchema.safeParse({
        source_id: "clinical",
        object_id: "report",
        query_permission_bindings,
      }).success,
    ).toBe(false);
  });

  it("拒绝重复参数策略", () => {
    expect(
      apiDatasetConfigSchema.safeParse({
        source_id: "clinical",
        object_id: "report",
        query_parameter_policies: [
          { name: "period", default_value: 7 },
          { name: "period", default_value: 14 },
        ],
      }).success,
    ).toBe(false);
  });

  it("拒绝同一固定输出字段的冲突脱敏配置", () => {
    expect(
      apiDatasetConfigSchema.safeParse({
        source_id: "clinical",
        object_id: "report",
        column_policies: [
          { field: "phone", default_masking: { type: "none" } },
          {
            field: "phone",
            default_masking: { type: "partial_mask", prefix_length: 0, suffix_length: 0 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("拒绝推断关系字段", () => {
    expect(
      apiDatasetConfigSchema.safeParse({
        source_id: "sales",
        object_id: "sales.orders",
        approved_relations: [
          {
            target_object_id: "sales.customer",
            description: "客户主键关联",
            column_pairs: [
              {
                source_column: "customer_id",
                target_column: "id",
              },
            ],
            confidence: 0.8,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("接受由多个字段 AND 连接的组合关系和多条候选关系", () => {
    const result = apiDatasetConfigSchema.parse({
      source_id: "sales",
      object_id: "sales.order_lines",
      approved_relations: [
        {
          target_object_id: "sales.orders",
          description: "按订单号和组织编码关联订单",
          column_pairs: [
            { source_column: "order_id", target_column: "id" },
            { source_column: "organization_id", target_column: "organization_id" },
          ],
        },
        {
          target_object_id: "sales.orders",
          description: "仅按订单号关联历史订单",
          column_pairs: [{ source_column: "order_id", target_column: "id" }],
        },
      ],
    });

    expect(result.approved_relations).toHaveLength(2);
    expect(result.approved_relations[0]?.column_pairs).toHaveLength(2);
  });
});

// 前提：API 依据目录粒度判断关联统计。验收：保存可验证的唯一键与关系基数，拒绝互相冲突的定义。
describe("数据集唯一键与关系基数合同", () => {
  const relation = {
    target_object_id: "sales.order_lines",
    description: "按订单关联明细",
    column_pairs: [{ source_column: "id", target_column: "order_id" }],
  };
  const config = { source_id: "sales", object_id: "sales.orders" };

  it.each(["one_to_one", "one_to_many", "many_to_one", "many_to_many"])(
    "接受唯一键和 %s 关系基数",
    (cardinality) => {
      const input = {
        ...config,
        unique_keys: [["id"], ["organization_id", "order_number"]],
        approved_relations: [{ ...relation, relation_id: "order_lines", cardinality }],
      };

      expect(apiDatasetConfigSchema.parse(input)).toMatchObject(input);
    },
  );

  it("省略统计元数据时保持既有关系配置", () => {
    const result = apiDatasetConfigSchema.parse({
      ...config,
      approved_relations: [relation, relation],
    });

    expect(result).not.toHaveProperty("unique_keys");
    expect(result.approved_relations).toEqual([relation, relation]);
  });

  it("接受空唯一键列表表示尚未声明可用唯一键", () => {
    expect(apiDatasetConfigSchema.parse({ ...config, unique_keys: [] })).toMatchObject({
      unique_keys: [],
    });
  });

  it.each([
    { name: "空键", unique_keys: [[]] },
    { name: "空字段", unique_keys: [[""]] },
    { name: "注入字段", unique_keys: [["id;DROP"]] },
    { name: "键中字段重复", unique_keys: [["id", "id"]] },
    { name: "唯一键重复", unique_keys: [["id"], ["id"]] },
    {
      name: "字段次序不同的同一复合键",
      unique_keys: [
        ["id", "organization_id"],
        ["organization_id", "id"],
      ],
    },
  ])("拒绝$name", ({ unique_keys }) => {
    expect(apiDatasetConfigSchema.safeParse({ ...config, unique_keys }).success).toBe(false);
  });

  it.each([
    { relation_id: "" },
    { relation_id: "order lines" },
    { relation_id: "order;DROP" },
    { cardinality: "unknown" },
    { cardinality: "one_to_many", cardinality_source: "inferred" },
  ])("拒绝非法关系元数据 %j", (metadata) => {
    expect(
      apiDatasetConfigSchema.safeParse({
        ...config,
        approved_relations: [{ ...relation, ...metadata }],
      }).success,
    ).toBe(false);
  });

  it("同一配置中的关系标识必须唯一", () => {
    expect(
      apiDatasetConfigSchema.safeParse({
        ...config,
        approved_relations: [
          { ...relation, relation_id: "order_lines" },
          { ...relation, target_object_id: "sales.archived_lines", relation_id: "order_lines" },
        ],
      }).success,
    ).toBe(false);
  });
});
