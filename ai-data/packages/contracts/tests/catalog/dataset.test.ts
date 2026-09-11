import { describe, expect, it } from "vitest";

import { datasetSchema } from "../../src/catalog/dataset";

describe("数据目录合同", () => {
  // BDD 场景：目录返回表、字段注释和关系候选；TDD 断言：完整目录对象可以通过校验。
  it("接受带字段和关系信息的数据集描述", () => {
    const result = datasetSchema.parse({
      source_id: "clinical",
      object_id: "clinical.outpatient_visit",
      name: "outpatient_visit",
      kind: "table",
      source_description: "门诊就诊记录",
      columns: [
        {
          name: "visit_id",
          data_type: "string",
          nullable: false,
        },
      ],
      query_parameters: [
        {
          name: "admission_date_from",
          data_type: "date",
          required: true,
          allowed_ops: ["between"],
          default_value: "2026-01-01",
          source_description: "入院开始日期",
        },
      ],
      query_capabilities: {
        filter_conditions: [
          {
            name: "visit_id",
            data_type: "string",
            allowed_ops: ["eq"],
            required: false,
          },
        ],
      },
    });

    expect(result.columns[0]?.name).toBe("visit_id");
    expect(result.query_parameters[0]?.name).toBe("admission_date_from");
    expect(result.query_parameters[0]?.default_value).toBe("2026-01-01");
    expect(result.query_capabilities?.filter_conditions?.[0]?.name).toBe("visit_id");
  });

  // BDD 场景：目录对象缺少字段类型；TDD 断言：不完整元数据必须拒绝。
  it("拒绝缺少字段类型的目录对象", () => {
    expect(
      datasetSchema.safeParse({
        source_id: "clinical",
        object_id: "clinical.visit",
        name: "visit",
        kind: "table",
        columns: [{ name: "id", nullable: false }],
      }).success,
    ).toBe(false);
  });

  // BDD 场景：调用方尝试把展示层别名写入纯目录；TDD 断言：目录合同拒绝 label 字段。
  it("拒绝字段展示别名", () => {
    expect(
      datasetSchema.safeParse({
        source_id: "clinical",
        object_id: "clinical.visit",
        name: "visit",
        kind: "table",
        columns: [
          {
            name: "id",
            label: "就诊编号",
            data_type: "string",
            nullable: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("保留存储过程和 API 数据集的真实对象类型", () => {
    const base = {
      source_id: "clinical",
      object_id: "clinical.admission_report",
      name: "admission_report",
      columns: [{ name: "patient_name", data_type: "string", nullable: true }],
    };

    expect(datasetSchema.parse({ ...base, kind: "stored_procedure" }).kind).toBe(
      "stored_procedure",
    );
    expect(datasetSchema.parse({ ...base, kind: "api_dataset" }).kind).toBe("api_dataset");
  });
});
