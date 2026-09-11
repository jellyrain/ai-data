import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  DataSourceConfig,
  EncryptedDataSourceSecret,
} from "../../src/metadata/metadata-records";
import { Aes256GcmSecretCipher } from "../../src/secrets/aes-256-gcm-secret-cipher";
import { SecretResolver } from "../../src/secrets/secret-resolver";

const sourceConfig: DataSourceConfig = {
  sourceId: "clinical_reporting",
  connectorKind: "sqlserver",
  secretRef: "secret-clinical",
  targetDatabase: "clinical",
  timeoutMs: 15000,
  connectionPoolLimit: 10,
  concurrencyLimit: 5,
  rowLimit: 1000,
  costLimit: 50000,
};

describe("数据源凭据解析器", () => {
  // BDD 场景：两个 SQL Server 数据源共用一个服务器账号；TDD 断言：共享密文只包含连接端点和登录凭据。
  it("解密并校验可复用的数据库凭据", async () => {
    const key = randomBytes(32);
    const resolver = new SecretResolver(
      createSecretLookup(
        encryptSecret(
          JSON.stringify({
            connectorKind: "sqlserver",
            host: "10.0.0.15",
            port: 1433,
            user: "reader",
            password: "secret",
          }),
          key,
        ),
      ),
      createKeyProvider(key),
    );

    await expect(resolver.resolve(sourceConfig)).resolves.toEqual({
      connectorKind: "sqlserver",
      host: "10.0.0.15",
      port: 1433,
      user: "reader",
      password: "secret",
    });
  });

  // BDD 场景：管理员把 MySQL 凭据误绑定到 SQL Server 配置；TDD 断言：类型不匹配时拒绝，且错误不包含明文密码。
  it("拒绝与数据源连接器类型不匹配的凭据", async () => {
    const key = randomBytes(32);
    const resolver = new SecretResolver(
      createSecretLookup(
        encryptSecret(
          JSON.stringify({
            connectorKind: "mysql",
            host: "10.0.0.15",
            port: 3306,
            user: "reader",
            password: "do-not-disclose",
          }),
          key,
        ),
      ),
      createKeyProvider(key),
    );

    await expect(resolver.resolve(sourceConfig)).rejects.toThrow("凭据类型与连接器类型不一致");
    await expect(resolver.resolve(sourceConfig)).rejects.not.toThrow("do-not-disclose");
  });

  // BDD 场景：Oracle 数据源绑定一个 SID；TDD 断言：连接目标在 source_id 配置中，密文可复用于同一服务器的其他目标。
  it("解析不含连接目标的 Oracle 共享凭据", async () => {
    const key = randomBytes(32);
    const oracleConfig: DataSourceConfig = {
      ...sourceConfig,
      sourceId: "clinical_oracle",
      connectorKind: "oracle",
      secretRef: "secret-clinical-oracle",
      targetDatabase: undefined,
      oracleConnectType: "sid",
      oracleConnectTarget: "CLINICAL",
    };
    const resolver = new SecretResolver(
      createSecretLookup(
        encryptSecret(
          JSON.stringify({
            connectorKind: "oracle",
            host: "10.0.0.20",
            port: 1521,
            user: "reader",
            password: "secret",
          }),
          key,
          oracleConfig.secretRef,
        ),
      ),
      createKeyProvider(key),
    );

    await expect(resolver.resolve(oracleConfig)).resolves.toEqual({
      connectorKind: "oracle",
      host: "10.0.0.20",
      port: 1521,
      user: "reader",
      password: "secret",
    });
  });
});

/** 创建一条与主密钥关联的元数据库密文记录替身。 */
function encryptSecret(
  plaintext: string,
  key: Buffer,
  secretRef = "secret-clinical",
): EncryptedDataSourceSecret {
  const cipher = new Aes256GcmSecretCipher();
  const encrypted = cipher.encrypt(Buffer.from(plaintext, "utf8"), key);
  return {
    secretRef,
    keyId: "key_20260828",
    encryptedPayload: encrypted.encryptedPayload,
    metadata: encrypted.metadata,
  };
}

/** 创建固定返回同一密文的仓储替身。 */
function createSecretLookup(secret: EncryptedDataSourceSecret) {
  return {
    async findBySecretRef(): Promise<EncryptedDataSourceSecret> {
      return secret;
    },
  };
}

/** 创建固定返回测试主密钥的本地密钥库替身。 */
function createKeyProvider(key: Buffer) {
  return {
    async getKey(): Promise<Buffer> {
      return key;
    },
  };
}
