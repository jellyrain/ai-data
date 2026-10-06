import { describe, expect, it } from "vitest";
import {
  managedSqlServerTransportSchema,
  sqlServerTransportSchema,
  sqlServerTransportUpdateSchema,
  sharedDatabaseCredentialsSchema,
} from "../../src/index";

/** 连接设置只接受显式布尔值，局部保存与回读均不能夹带登录资料。 */
describe("SQL Server 业务连接选项合同", () => {
  const transport = { encrypt: true, trust_server_certificate: false };
  const update = { expected_revision: "a".repeat(64), sqlserver_transport: transport };
  const read = {
    secret_ref: "reader",
    connector_kind: "sqlserver",
    sqlserver_transport: transport,
    origin: "default",
    revision: update.expected_revision,
    sources: [{ source_id: "clinical", origin: "deployment", sqlserver_transport: transport }],
  };
  it.each([true, false])("加密 %s 与证书信任值分别保存", (encrypt) => {
    for (const trust_server_certificate of [true, false])
      expect(sqlServerTransportSchema.parse({ encrypt, trust_server_certificate })).toEqual({
        encrypt,
        trust_server_certificate,
      });
  });
  it.each([
    {},
    { encrypt: "true", trust_server_certificate: false },
    { ...transport, password: "private" },
  ])("拒绝缺失、非布尔或未知字段 %j", (value) => {
    expect(sqlServerTransportSchema.safeParse(value).success).toBe(false);
  });
  it("读取支持旧来源，局部写入要求完整修订且拒绝密码", () => {
    expect(managedSqlServerTransportSchema.parse(read)).toEqual(read);
    expect(sqlServerTransportUpdateSchema.parse(update)).toEqual(update);
    for (const value of [
      { ...update, expected_revision: "" },
      { sqlserver_transport: transport },
      { ...update, password: "private" },
    ])
      expect(sqlServerTransportUpdateSchema.safeParse(value).success).toBe(false);
    for (const value of [
      { ...read, origin: "unknown" },
      { ...read, password: "private" },
      { ...read, sources: [{ ...read.sources[0], password: "private" }] },
    ])
      expect(managedSqlServerTransportSchema.safeParse(value).success).toBe(false);
  });
  it.each(["sqlserver", "mysql", "postgresql", "oracle"])(
    "%s 凭据仅按支持的数据库类型接收选项",
    (connector_kind) => {
      const credentials = {
        secret_ref: "reader",
        connector_kind,
        host: "database.test",
        port: 1433,
        user: "reader",
        password: "private",
      };
      expect(sharedDatabaseCredentialsSchema.safeParse(credentials).success).toBe(true);
      expect(
        sharedDatabaseCredentialsSchema.safeParse({
          ...credentials,
          sqlserver_transport: transport,
        }).success,
      ).toBe(connector_kind === "sqlserver");
    },
  );
});
