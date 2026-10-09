import { describe, expect, it } from "vitest";
import { dataSourceManagementConfigSchema } from "../../src/index";

const input = {
  connector_kind: "sqlserver",
  secret_ref: "医院业务库",
  target_database: "business",
  timeout_ms: 30000,
  connection_pool_limit: 5,
  concurrency_limit: 5,
  row_limit: 10000,
};

describe("数据源中文标识", () => {
  it.each([
    "门诊数据",
    "門診資料",
    "门诊_data-2026.v1",
    "clinical-demo",
    "_门诊",
    "源".repeat(128),
  ])("接受中文或既有英文标识 %s，并保留原值", (source_id) => {
    expect(dataSourceManagementConfigSchema.parse({ ...input, source_id })).toMatchObject({
      source_id,
      secret_ref: "医院业务库",
    });
  });
  it.each([
    "",
    " 门诊",
    "门诊 ",
    "门 诊",
    "1门诊",
    "门诊/数据",
    "门诊\\数据",
    "门诊?x=1",
    "源".repeat(129),
  ])("拒绝空值、超长或不符合命名规则的标识 %s", (source_id) => {
    expect(dataSourceManagementConfigSchema.safeParse({ ...input, source_id }).success).toBe(false);
  });
});
