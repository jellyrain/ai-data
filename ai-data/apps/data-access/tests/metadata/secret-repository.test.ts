import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { SecretRepository } from "../../src/metadata/secret-repository";

describe("数据源密文仓储", () => {
  // BDD 场景：凭据解析器需要读取一条已存数据源密文；TDD 断言：仓储参数化读取密文并解析 AES-GCM 元数据。
  it("按 secret_ref 读取 AES-GCM 密文", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new SecretRepository(
      createExecutor(
        [
          {
            secret_ref: "secret-clinical",
            encryption_algorithm: "AES-256-GCM",
            key_id: "key_20260828",
            encrypted_payload: Buffer.from("ciphertext"),
            encryption_metadata_json:
              '{"iv_hex":"00112233445566778899aabb","auth_tag_hex":"00112233445566778899aabbccddeeff"}',
          },
        ],
        statements,
      ),
    );

    await expect(repository.findBySecretRef("secret-clinical")).resolves.toEqual({
      secretRef: "secret-clinical",
      keyId: "key_20260828",
      encryptedPayload: Buffer.from("ciphertext"),
      metadata: {
        iv_hex: "00112233445566778899aabb",
        auth_tag_hex: "00112233445566778899aabbccddeeff",
      },
    });
    expect(statements[0]?.sql).not.toContain("secret-clinical");
    expect(statements[0]?.parameters).toEqual([
      { name: "secret_ref", type: "string", value: "secret-clinical" },
    ]);
  });

  // BDD 场景：密钥引用不存在；TDD 断言：仓储不构造空密文，而由调用方决定拒绝策略。
  it("找不到密文时返回 undefined", async () => {
    const repository = new SecretRepository(createExecutor([]));

    await expect(repository.findBySecretRef("missing-secret")).resolves.toBeUndefined();
  });

  // BDD 场景：管理员更新一套共享凭据；TDD 断言：密文及其密钥版本通过参数化语句保存。
  it("保存或更新 AES-GCM 密文", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new SecretRepository(createExecutor([], statements));

    await repository.upsert({
      secretRef: "secret-clinical",
      keyId: "key_20260831",
      encryptedPayload: Buffer.from("ciphertext"),
      metadata: {
        iv_hex: "00112233445566778899aabb",
        auth_tag_hex: "00112233445566778899aabbccddeeff",
      },
    });

    expect(statements[0]?.sql).toContain("UPDATE dbo.data_source_secrets");
    expect(statements[0]?.sql).toContain("INSERT INTO dbo.data_source_secrets");
    expect(statements[0]?.parameters).toEqual(
      expect.arrayContaining([
        { name: "secret_ref", type: "string", value: "secret-clinical" },
        { name: "key_id", type: "string", value: "key_20260831" },
      ]),
    );
  });
});

/** 创建记录参数化语句的元数据库执行器替身。 */
function createExecutor(
  rows: Record<string, unknown>[],
  statements: MetadataStatement[] = [],
): MetadataQueryExecutor {
  return {
    async execute<T extends Record<string, unknown>>(
      statement: MetadataStatement,
    ): Promise<MetadataQueryResult<T>> {
      statements.push(statement);
      return { rows: rows as T[], rowsAffected: [0] };
    },
  };
}
