import { describe, expect, it } from "vitest";

import { apiDatasetConfigSchema } from "../../src/catalog/api-dataset";

describe("API 数据集配置合同", () => {
  // BDD 场景：API 配置业务说明和批准关系；TDD 断言：配置合同接受业务增强信息。
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

  // BDD 场景：API 未配置任何关联；TDD 断言：关联列表默认为空，不允许自动推断。
  it("允许没有批准关联的业务配置", () => {
    const result = apiDatasetConfigSchema.parse({
      source_id: "sales",
      object_id: "sales.orders",
    });

    expect(result.approved_relations).toEqual([]);
    expect(result.column_descriptions).toEqual([]);
    expect(result.column_policies).toEqual([]);
  });

  // BDD 场景：调用方试图把关系可信度或推断来源写入 API 配置；TDD 断言：关系必须是明确批准的结构。
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
