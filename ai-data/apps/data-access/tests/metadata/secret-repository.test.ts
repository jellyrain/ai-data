import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { SecretRepository } from "../../src/metadata/secret-repository";

// 使用固定密文占位内容检查仓储映射和参数绑定，密码学往返由 cipher 测试验证。
describe("数据源密文仓储", () => {
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

  it("找不到密文时返回 undefined", async () => {
    const repository = new SecretRepository(createExecutor([]));

    await expect(repository.findBySecretRef("missing-secret")).resolves.toBeUndefined();
  });

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
