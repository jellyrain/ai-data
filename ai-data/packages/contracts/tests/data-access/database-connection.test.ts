import { describe, expect, it } from "vitest";
import {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  testDatabaseConnectionDraftSchema,
} from "../../src/index";
const input = {
  secret_ref: "hospital",
  connector_kind: "sqlserver",
  host: "db.test",
  port: 1433,
  user: "reader",
  password: "p",
};
describe("数据库连接管理合同", () => {
  it("保存前测试不要求连接名称，新建密码必填，编辑引用必须带修订", () => {
    const { secret_ref, ...draft } = input;
    expect(testDatabaseConnectionDraftSchema.safeParse(draft).success).toBe(true);
    expect(testDatabaseConnectionDraftSchema.safeParse({ ...draft, password: "" }).success).toBe(
      false,
    );
    expect(
      testDatabaseConnectionDraftSchema.safeParse({
        ...draft,
        password: "",
        saved_connection: { secret_ref, expected_revision: "a".repeat(64) },
      }).success,
    ).toBe(true);
    expect(
      testDatabaseConnectionDraftSchema.safeParse({
        ...draft,
        password: "",
        saved_connection: { secret_ref },
      }).success,
    ).toBe(false);
  });
  it("草稿测试按类型检查连接选项和 Oracle 入口", () => {
    const { secret_ref, ...draft } = input;
    void secret_ref;
    const oracle = { ...draft, connector_kind: "oracle", port: 1521 };
    expect(testDatabaseConnectionDraftSchema.safeParse(oracle).success).toBe(false);
    expect(
      testDatabaseConnectionDraftSchema.safeParse({
        ...oracle,
        oracle_connect_type: "service_name",
        oracle_connect_target: "orcl",
      }).success,
    ).toBe(true);
    expect(
      testDatabaseConnectionDraftSchema.safeParse({
        ...draft,
        oracle_connect_type: "sid",
        oracle_connect_target: "orcl",
      }).success,
    ).toBe(false);
    expect(
      testDatabaseConnectionDraftSchema.safeParse({
        ...oracle,
        sqlserver_transport: { encrypt: true, trust_server_certificate: true },
      }).success,
    ).toBe(false);
  });
  it("新建要求密码且名称适配持久化长度", () => {
    expect(createDatabaseConnectionSchema.parse(input)).toEqual(input);
    expect(createDatabaseConnectionSchema.safeParse({ ...input, password: "" }).success).toBe(
      false,
    );
    expect(
      createDatabaseConnectionSchema.safeParse({ ...input, secret_ref: "a".repeat(129) }).success,
    ).toBe(false);
  });
  it("中文连接名称可创建和回读，更新仍拒绝改名", () => {
    const created = createDatabaseConnectionSchema.parse({ ...input, secret_ref: "医院业务库" });
    expect(created.secret_ref).toBe("医院业务库");
    const { password, ...publicInput } = created;
    void password;
    const saved = { ...publicInput, source_ids: ["门诊数据"], revision: "a".repeat(64) };
    expect(databaseConnectionSchema.parse(saved)).toEqual(saved);
    expect(
      updateDatabaseConnectionSchema.safeParse({
        host: input.host,
        port: input.port,
        user: input.user,
        expected_revision: saved.revision,
        secret_ref: "新名称",
      }).success,
    ).toBe(false);
  });
  it("编辑允许密码留空或省略，要求版本且拒绝修改连接类型", () => {
    const value = {
      host: "db.test",
      port: 1433,
      user: "reader",
      expected_revision: "a".repeat(64),
    };
    expect(updateDatabaseConnectionSchema.safeParse(value).success).toBe(true);
    expect(updateDatabaseConnectionSchema.safeParse({ ...value, password: "" }).success).toBe(true);
    expect(
      updateDatabaseConnectionSchema.safeParse({ ...value, connector_kind: "mysql" }).success,
    ).toBe(false);
    expect(
      updateDatabaseConnectionSchema.safeParse({ ...value, expected_revision: undefined }).success,
    ).toBe(false);
  });
  it("公开回读拒绝密码字段及密文字段", () => {
    const { password, ...publicInput } = input;
    void password;
    const value = { ...publicInput, revision: "a".repeat(64), source_ids: [] };
    expect(databaseConnectionSchema.safeParse(value).success).toBe(true);
    expect(databaseConnectionSchema.safeParse({ ...value, password: "p" }).success).toBe(false);
    expect(databaseConnectionSchema.safeParse({ ...value, encrypted_payload: "p" }).success).toBe(
      false,
    );
  });
});
