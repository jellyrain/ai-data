import { describe, expect, it } from "vitest";

import { datasetSchema } from "../../src/catalog/dataset";

// 目录样本同时携带字段、输入参数默认值与过滤能力，用于检查这些元数据能被完整读取。
describe("数据目录合同", () => {
  it("完整固定输出须有非空且唯一的列集合", () => {
    const base = {
      source_id: "clinical",
      object_id: "report",
      name: "report",
      kind: "stored_procedure",
      has_complete_output: true,
    };
    const column = { name: "id", data_type: "integer", nullable: false };
    expect(datasetSchema.parse({ ...base, columns: [column] }).has_complete_output).toBe(true);
    expect(datasetSchema.safeParse({ ...base, columns: [] }).success).toBe(false);
    expect(datasetSchema.safeParse({ ...base, columns: [column, column] }).success).toBe(false);
    expect(
      datasetSchema.parse({ ...base, has_complete_output: false, columns: [] }).has_complete_output,
    ).toBe(false);
  });
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
