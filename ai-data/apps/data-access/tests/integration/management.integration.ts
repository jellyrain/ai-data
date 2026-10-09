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
import { DataSourceRepository } from "../../src/metadata/data-source-repository";
import { ExposedObjectRepository } from "../../src/metadata/exposed-object-repository";
import { SecretResolver } from "../../src/secrets/secret-resolver";
import { DataSourceManager } from "../../src/data-sources/data-source-manager";
import { DataSourceManagementService } from "../../src/data-sources/data-source-management-service";
import { DatabaseConnectorFactory } from "../../src/connectors/database-connector-factory";
import { verifyChineseObjects } from "./chinese-objects";
import { Aes256GcmSecretCipher } from "@ai-data/metadata/secrets";
import { DatabaseServerTargetDiscovery } from "../../src/data-sources/database-target-discovery";
import {
  DatabaseConnectionService,
  connectionRevision,
} from "../../src/data-sources/database-connection-service";
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
  it("空环境通过连接管理显式创建，空密码编辑保持，删除拒绝停用源引用", async () => {
    const repository = new SecretRepository(database);
    const key = Buffer.alloc(32, 6);
    const connections = new DatabaseConnectionService({
      repository,
      administration: service,
      keys: {
        getKey: async () => key,
        getActiveKey: async () => ({ keyId: "connection-test", value: key }),
      },
      cipher: new Aes256GcmSecretCipher(),
      runtime: { invalidateBySecretRef: async () => {} },
      discovery: { listDatabaseTargets: async () => [] },
    });
    expect(await connections.list()).toEqual({ items: [] });
    const created = await connections.create({
      secret_ref: "test-connection",
      connector_kind: "sqlserver",
      host: "sql.test",
      port: 1433,
      user: "reader",
      password: "isolated-password",
    });
    expect(created.source_ids).toEqual([]);
    const changed = await connections.update("test-connection", {
      expected_revision: created.revision,
      host: "changed.test",
      port: 1433,
      user: "reader",
      password: "",
    });
    const stored = (await repository.findBySecretRef("test-connection"))!;
    const decoded = JSON.parse(
      new Aes256GcmSecretCipher()
        .decrypt({ encryptedPayload: stored.encryptedPayload, metadata: stored.metadata }, key)
        .toString(),
    );
    expect(decoded.password).toBe("isolated-password");
    await service.saveConnectedSource(
      { ...source, sourceId: "bound-test", secretRef: "test-connection" },
      false,
      changed.revision,
      managementRevision(null),
    );
    await expect(
      connections.remove("test-connection", { expected_revision: changed.revision }),
    ).rejects.toThrow(/使用/);
    expect((await connections.get("test-connection")).source_ids).toEqual(["bound-test"]);
    await database.execute({
      sql: "DELETE FROM dbo.data_source_configs WHERE source_id='bound-test'",
      parameters: [],
    });
    await connections.remove("test-connection", { expected_revision: changed.revision });
    expect(await connections.list()).toEqual({ items: [] });
  });
  it("连接删除与数据源绑定并发时仅一方成功，始终保留有效引用", async () => {
    const repository = new SecretRepository(database),
      cipher = new Aes256GcmSecretCipher();
    const encrypted = cipher.encrypt(
      Buffer.from(
        JSON.stringify({
          connectorKind: "sqlserver",
          host: "sql.test",
          port: 1433,
          user: "r",
          password: "p",
        }),
      ),
      Buffer.alloc(32, 4),
    );
    const secret = {
      secretRef: "race-connection",
      keyId: "test",
      encryptedPayload: encrypted.encryptedPayload,
      metadata: encrypted.metadata,
    };
    await repository.replace(secret, undefined);
    const results = await Promise.allSettled([
      service.deleteConnection(secret),
      service.saveConnectedSource(
        { ...source, sourceId: "race-source", secretRef: secret.secretRef },
        false,
        connectionRevision(secret),
        managementRevision(null),
      ),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const binding = await service.source("race-source");
    expect(Boolean(await repository.findBySecretRef(secret.secretRef))).toBe(
      Boolean(binding.config),
    );
    if (binding.config) {
      await database.execute({
        sql: "DELETE FROM dbo.data_source_configs WHERE source_id='race-source'",
        parameters: [],
      });
      await service.deleteConnection(secret);
    }
  });
  it("中文连接与数据源可创建、编辑参数、发现数据库并执行真实 SQL", async () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../config/das.config.json", import.meta.url)), "utf8"),
    );
    const config = dasConfigSchema.shape.metadata_sqlserver.parse(raw.metadata_sqlserver);
    const key = Buffer.alloc(32, 5);
    const connections = new DatabaseConnectionService({
      repository: new SecretRepository(database),
      administration: service,
      keys: {
        getKey: async () => key,
        getActiveKey: async () => ({ keyId: "live-connection-test", value: key }),
      },
      cipher: new Aes256GcmSecretCipher(),
      runtime: { invalidateBySecretRef: async () => {} },
      discovery: new DatabaseServerTargetDiscovery(),
    });
    const draft = {
      connector_kind: "sqlserver",
      host: config.server,
      port: config.port,
      user: config.user,
      password: config.password,
      sqlserver_transport: {
        encrypt: config.options.encrypt,
        trust_server_certificate: config.options.trust_server_certificate,
      },
    };
    const tested = await connections.testDraft(draft).catch(() => {
      throw new Error("真实保存前测试未能完成数据库发现");
    });
    expect(tested.databases.some((item) => item.name === name)).toBe(true);
    expect((await connections.list()).items).toHaveLength(0);
    const created = await connections.create({ ...draft, secret_ref: "医院业务库" });
    const editedTest = await connections
      .testDraft({
        ...draft,
        password: "",
        saved_connection: { secret_ref: created.secret_ref, expected_revision: created.revision },
      })
      .catch(() => {
        throw new Error("真实编辑草稿测试未能完成数据库发现");
      });
    expect(editedTest.databases.some((item) => item.name === name)).toBe(true);
    expect((await connections.get(created.secret_ref)).revision).toBe(created.revision);
    const changed = await connections.update(created.secret_ref, {
      expected_revision: created.revision,
      host: created.host,
      port: created.port,
      user: created.user,
      password: "",
    });
    const result = await connections.test(created.secret_ref, {}).catch(() => {
      throw new Error("真实 SQL Server 连接未能完成只读数据库发现");
    });
    expect(result.databases.some((item) => item.name === name)).toBe(true);
    expect(Object.hasOwn(changed, "password")).toBe(false);
    const repository = new SecretRepository(database);
    const configs = new DataSourceRepository(database);
    const keys = {
      getKey: async () => key,
      getActiveKey: async () => ({ keyId: "live-connection-test", value: key }),
    };
    const resolver = new SecretResolver(repository, keys);
    const runtime = new DataSourceManager(configs, resolver, new DatabaseConnectorFactory());
    const management = new DataSourceManagementService(
      repository,
      configs,
      new ExposedObjectRepository(database),
      resolver,
      keys,
      new Aes256GcmSecretCipher(),
      new DatabaseServerTargetDiscovery(),
      runtime,
      service,
    );
    try {
      const input = {
        source_id: "门诊数据",
        connector_kind: "sqlserver",
        secret_ref: created.secret_ref,
        target_database: name,
        timeout_ms: 30000,
        connection_pool_limit: 1,
        concurrency_limit: 1,
        row_limit: 100,
        expected_revision: managementRevision(null),
      };
      expect(await management.saveDataSource(input)).toEqual({ source_id: "门诊数据" });
      const saved = await management.getDataSource("门诊数据");
      expect(saved.config).toMatchObject({ source_id: "门诊数据", secret_ref: "医院业务库" });
      await expect(
        management.saveDataSource({
          ...input,
          source_id: "新名称",
          expected_revision: saved.revision,
        }),
      ).rejects.toMatchObject({ name: "ManagementConflict" });
      expect((await management.getDataSource("新名称")).config).toBeNull();
      const connector = await runtime.get("门诊数据");
      const queried = await connector.execute({
        type: "relational_query",
        source_id: "门诊数据",
        timeout_ms: 30000,
        row_limit: 100,
        from: {
          object_id: "configs",
          native_schema_name: "dbo",
          native_object_name: "data_source_configs",
          alias: "s",
        },
        select: [{ field: "s.source_id", as: "source_id" }],
        joins: [],
        group_by: [],
        order_by: [],
        filters: {
          logic: "and",
          items: [{ field: "s.source_id", op: "eq", data_type: "string", value: "门诊数据" }],
        },
      });
      expect(queried.rows).toEqual([{ source_id: "门诊数据" }]);
      await verifyChineseObjects(database, management, runtime, configs);
      await management.deleteDataSource({
        source_id: "门诊数据",
        expected_revision: saved.revision,
        expected_objects_revision: (await management.getSourceObjects("门诊数据")).revision,
      });
    } finally {
      await runtime.close();
    }
    await connections.remove(created.secret_ref, { expected_revision: changed.revision });
  });
  it("删除数据源核对配置和白名单修订，清理配置与对象并保留连接", async () => {
    const id = "delete-source";
    const repository = new SecretRepository(database);
    const encrypted = new Aes256GcmSecretCipher().encrypt(Buffer.from("{}"), Buffer.alloc(32, 7));
    const secret = {
      secretRef: "delete-retained-connection",
      keyId: "test",
      encryptedPayload: encrypted.encryptedPayload,
      metadata: encrypted.metadata,
    };
    await repository.replace(secret, undefined);
    const baseline = await service.source(id);
    const input = { ...source, sourceId: id, secretRef: secret.secretRef };
    await service.saveSource(input, false, baseline.revision);
    const config = await service.source(id);
    const before = await service.objects(id);
    await service.saveObjects(id, [{ ...object, sourceId: id }], before.revision);
    await expect(service.deleteSource(id, config.revision, before.revision)).rejects.toMatchObject({
      name: "ManagementConflict",
    });
    await service.saveSource({ ...input, rowLimit: 500 }, false, config.revision);
    const objects = await service.objects(id),
      latest = await service.source(id);
    await expect(service.deleteSource(id, config.revision, objects.revision)).rejects.toMatchObject(
      { name: "ManagementConflict" },
    );
    await service.deleteSource(id, latest.revision, objects.revision);
    expect(await repository.findBySecretRef(secret.secretRef)).toEqual(secret);
    expect((await service.source(id)).config).toBeNull();
    expect((await service.objects(id)).items).toEqual([]);
    await expect(
      service.saveSource({ ...source, sourceId: id }, true, config.revision),
    ).rejects.toMatchObject({ name: "ManagementConflict" });
    await expect(
      service.saveObjects(id, [], (await service.objects(id)).revision),
    ).rejects.toMatchObject({ name: "ManagementConflict" });
    await service.deleteConnection(secret);
  });
  it("删除与白名单更新并发时仅一方成功，不遗留孤立对象", async () => {
    const id = "delete-race";
    await service.saveSource({ ...source, sourceId: id }, false, managementRevision(null));
    const config = await service.source(id),
      objects = await service.objects(id);
    const results = await Promise.allSettled([
      service.deleteSource(id, config.revision, objects.revision),
      service.saveObjects(id, [{ ...object, sourceId: id }], objects.revision),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const current = await service.source(id),
      currentObjects = await service.objects(id);
    expect(currentObjects.items.length).toBe(current.config ? 1 : 0);
    if (current.config) await service.deleteSource(id, current.revision, currentObjects.revision);
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
