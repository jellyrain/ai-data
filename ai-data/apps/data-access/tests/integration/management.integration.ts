import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { dasConfigSchema } from "../../src/config/das-config";
import {
  SqlDataSourceAdministration,
  managementRevision,
} from "../../src/metadata/sql-data-source-administration";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";
import type { ExposedSourceObject } from "../../src/catalog/catalog-types";
import { SecretRepository } from "../../src/metadata/secret-repository";
import { Aes256GcmSecretCipher } from "@ai-data/metadata/secrets";
/** 独立 DAS 元数据库验证修订指纹、锁内比较和完整白名单往返。 */
describe("SQL Server DAS 管理比较更新", () => {
  const name = "ai_data_das_management_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase,
    database: SqlServerMetadataDatabase,
    service: SqlDataSourceAdministration,
    created = false;
  const source: DataSourceConfig = {
    sourceId: "clinical",
    connectorKind: "sqlserver",
    secretRef: "isolated-ref",
    targetDatabase: "unavailable-business-database",
    timeoutMs: 10000,
    connectionPoolLimit: 1,
    concurrencyLimit: 1,
    rowLimit: 100,
    costLimit: 1,
  };
  const object: ExposedSourceObject = {
    sourceId: "clinical",
    objectId: "visits",
    objectKind: "table",
    nativeSchemaName: "dbo",
    nativeObjectName: "inpatient",
    isDiscoverable: false,
    isQueryable: false,
    queryCapabilities: { sortable_fields: [] },
  };
  beforeAll(async () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../config/das.config.json", import.meta.url)), "utf8"),
    ) as Record<string, unknown>;
    const config = dasConfigSchema.shape.metadata_sqlserver.parse(raw.metadata_sqlserver);
    admin = await SqlServerMetadataDatabase.connect({ ...config, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({ ...config, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    service = new SqlDataSourceAdministration(database);
  });
  it("密文比较写入阻止旧参数覆盖新密码，并发首次创建只成功一次", async () => {
    const repository = new SecretRepository(database);
    const make = (password: string) => {
      const encrypted = new Aes256GcmSecretCipher().encrypt(
        Buffer.from(JSON.stringify({ password })),
        Buffer.alloc(32, 9),
      );
      return {
        secretRef: "transport-test",
        keyId: "key-test",
        encryptedPayload: encrypted.encryptedPayload,
        metadata: encrypted.metadata,
      };
    };
    const first = make("first"),
      second = make("second");
    const created = await Promise.all([
      repository.replace(first, undefined),
      repository.replace(second, undefined),
    ]);
    expect(created.filter(Boolean)).toHaveLength(1);
    const baseline = (await repository.findBySecretRef("transport-test"))!;
    const rotated = make("rotated");
    expect(await repository.replace(rotated, baseline)).toBe(true);
    expect(await repository.replace(make("stale"), baseline)).toBe(false);
    expect((await repository.findBySecretRef("transport-test"))?.encryptedPayload).toEqual(
      rotated.encryptedPayload,
    );
    await database.execute({
      sql: "DELETE FROM dbo.data_source_secrets WHERE secret_ref = @ref",
      parameters: [{ name: "ref", type: "string", value: "transport-test" }],
    });
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_das_management_test_[a-f0-9]{32}$/.test(name))
          throw new Error("隔离库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  it("业务连接不可达也可创建和读取停用配置，空基准只能创建一次", async () => {
    const baseline = await service.source(source.sourceId);
    expect(baseline).toEqual({ config: null, revision: managementRevision(null) });
    await service.saveSource(source, false, baseline.revision);
    expect((await service.sources()).items[0]).toMatchObject({
      source_id: "clinical",
      is_enabled: false,
    });
    await expect(service.saveSource(source, false, baseline.revision)).rejects.toMatchObject({
      name: "ManagementConflict",
    });
  });
  it("完整白名单保持别名、开关和显式空能力，同基准并发只写入一方", async () => {
    const baseline = await service.objects("clinical");
    const results = await Promise.allSettled([
      service.saveObjects("clinical", [object], baseline.revision),
      service.saveObjects("clinical", [object], baseline.revision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { name: "ManagementConflict" },
    });
    expect((await service.objects("clinical")).items).toEqual([object]);
  });
  it("源目标更换使之前发现的白名单基准失效，清空保存支持回读", async () => {
    const baseline = await service.objects("clinical"),
      config = await service.source("clinical");
    await service.saveSource(
      { ...source, targetDatabase: "changed-target" },
      false,
      config.revision,
    );
    await expect(
      service.saveObjects("clinical", [object], baseline.revision),
    ).rejects.toMatchObject({ name: "ManagementConflict" });
    const current = await service.objects("clinical");
    await service.saveObjects("clinical", [], current.revision);
    expect((await service.objects("clinical")).items).toEqual([]);
    expect((await service.secrets()).items).toEqual([
      { secret_ref: "isolated-ref", exists: false, source_ids: ["clinical"] },
    ]);
  });
});
