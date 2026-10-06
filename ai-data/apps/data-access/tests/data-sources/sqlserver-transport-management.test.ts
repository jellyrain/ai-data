import { describe, expect, it } from "vitest";
import { Aes256GcmSecretCipher } from "@ai-data/metadata/secrets";
import { sharedDatabaseCredentialsSchema } from "@ai-data/contracts";
import { DataSourceManagementService } from "../../src/data-sources/data-source-management-service";
import { SecretResolver } from "../../src/secrets/secret-resolver";
import type { EncryptedDataSourceSecret } from "../../src/secrets/secret-types";

const credentials = {
  secret_ref: "reader",
  connector_kind: "sqlserver",
  host: "sql.test",
  port: 1433,
  user: "reader",
  password: "private-password",
};
const transport = { encrypt: true, trust_server_certificate: true };
/** 使用真实密文和受比较保护的内存存储，验证参数保存的秘密保持和冲突行为。 */
function fixture() {
  let stored: EncryptedDataSourceSecret | undefined;
  const key = Buffer.alloc(32, 7),
    cipher = new Aes256GcmSecretCipher();
  const keys = {
    getKey: async () => key,
    getActiveKey: async () => ({ keyId: "test-key", value: key }),
  };
  const repository = {
    findBySecretRef: async () => stored,
    replace: async (
      next: EncryptedDataSourceSecret,
      previous: EncryptedDataSourceSecret | undefined,
    ) => {
      if (stored !== previous) return false;
      stored = next;
      return true;
    },
  };
  const invalidations: string[] = [];
  const service = new DataSourceManagementService(
    repository as never,
    {} as never,
    {} as never,
    new SecretResolver(repository, keys),
    keys,
    cipher,
    {} as never,
    {
      invalidateBySecretRef: async (ref: string) => {
        invalidations.push(ref);
      },
    } as never,
    {
      sources: async () => ({
        items: [
          { source_id: "clinical", secret_ref: "reader" },
          { source_id: "archive", secret_ref: "reader" },
        ],
      }),
    } as never,
    { clinical: { encrypt: false, trust_server_certificate: true } },
  );
  const plaintext = () =>
    JSON.parse(
      cipher
        .decrypt({ encryptedPayload: stored!.encryptedPayload, metadata: stored!.metadata }, key)
        .toString(),
    );
  return { service, plaintext, invalidations };
}

describe("SQL Server 业务连接选项管理", () => {
  it("保存连接选项并公开回读，多个源采用相同设置且秘密不回传", async () => {
    const { service, plaintext, invalidations } = fixture();
    await service.saveSharedCredentials({ ...credentials, sqlserver_transport: transport });
    expect(plaintext()).toMatchObject({
      password: credentials.password,
      sqlserver_transport: transport,
    });
    const state = await service.getSqlServerTransport("reader");
    expect(state).toMatchObject({
      sqlserver_transport: transport,
      origin: "credential",
      sources: [
        { source_id: "clinical", origin: "credential", sqlserver_transport: transport },
        { source_id: "archive", origin: "credential", sqlserver_transport: transport },
      ],
    });
    expect(JSON.stringify(state)).not.toMatch(/private-password|sql\.test|encrypted/);
    expect(invalidations).toEqual(["reader"]);
  });
  it("旧凭据明确展示默认发现设置及各源文件配置，局部保存保持完整登录内容", async () => {
    const { service, plaintext } = fixture();
    await service.saveSharedCredentials(credentials);
    const before = await service.getSqlServerTransport("reader");
    expect(before).toMatchObject({
      origin: "default",
      sqlserver_transport: { encrypt: true, trust_server_certificate: false },
      sources: [
        {
          source_id: "clinical",
          origin: "deployment",
          sqlserver_transport: { encrypt: false, trust_server_certificate: true },
        },
        { source_id: "archive", origin: "default" },
      ],
    });
    const old = plaintext();
    await service.saveSqlServerTransport("reader", {
      expected_revision: before.revision,
      sqlserver_transport: transport,
    });
    expect(plaintext()).toEqual({ ...old, sqlserver_transport: transport });
    expect((await service.getSqlServerTransport("reader")).origin).toBe("credential");
  });
  it("密码更新后旧修订无法覆盖新凭据，旧调用方省略选项时保持已存设置", async () => {
    const { service, plaintext } = fixture();
    await service.saveSharedCredentials({ ...credentials, sqlserver_transport: transport });
    const before = await service.getSqlServerTransport("reader");
    await service.saveSharedCredentials({ ...credentials, password: "rotated-password" });
    await expect(
      service.saveSqlServerTransport("reader", {
        expected_revision: before.revision,
        sqlserver_transport: { encrypt: false, trust_server_certificate: false },
      }),
    ).rejects.toThrow(/更新|冲突/);
    expect(plaintext()).toMatchObject({
      password: "rotated-password",
      sqlserver_transport: transport,
    });
  });
  it.each(["mysql", "postgresql", "oracle"])("%s 拒绝 SQL Server 专属选项", (connector_kind) => {
    expect(
      sharedDatabaseCredentialsSchema.safeParse({
        ...credentials,
        connector_kind,
        sqlserver_transport: transport,
      }).success,
    ).toBe(false);
  });
  it("布尔参数不接受字符串，并支持独立设置两个值", () => {
    expect(
      sharedDatabaseCredentialsSchema.safeParse({
        ...credentials,
        sqlserver_transport: { encrypt: "true", trust_server_certificate: true },
      }).success,
    ).toBe(false);
    expect(
      sharedDatabaseCredentialsSchema.parse({
        ...credentials,
        sqlserver_transport: { encrypt: false, trust_server_certificate: true },
      }),
    ).toHaveProperty("sqlserver_transport.encrypt", false);
  });
});
