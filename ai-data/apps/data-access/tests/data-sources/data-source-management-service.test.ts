import { describe, expect, it } from "vitest";

import { DataSourceManagementService } from "../../src/data-sources/data-source-management-service";
import type { DatabaseTargetDiscovery } from "../../src/data-sources/database-target-discovery";
import type { DiscoveredDataset } from "../../src/connectors/connector-catalog";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";
import type { EncryptedDataSourceSecret } from "../../src/secrets/secret-types";
import type { ExposedSourceObject } from "../../src/catalog/catalog-types";
import { Aes256GcmSecretCipher, type ActiveMasterKeyProvider } from "@ai-data/metadata/secrets";
import type { DataSourceSecretResolver } from "../../src/secrets/secret-resolver";

// 按场景替换写入、发现和运行时依赖，检查管理服务传递的数据及失效请求。
describe("数据源管理服务", () => {
  it("带修订基准保存白名单时保留逻辑 ID、禁用查询和已有能力", async () => {
    const stored = {
      sourceId: "clinical",
      objectId: "visits",
      objectKind: "table",
      nativeSchemaName: "dbo",
      nativeObjectName: "visits",
      isDiscoverable: true,
      isQueryable: false,
      queryCapabilities: { sortable_fields: [] },
    };
    const saved: unknown[] = [];
    const service = createService({
      administration: {
        objects: async () => ({ items: [stored], revision: "a".repeat(64) }),
        saveObjects: async (...values: unknown[]) => {
          saved.push(values);
        },
      },
      runtime: createRuntime([
        { kind: "table", native_schema_name: "dbo", native_object_name: "visits", columns: [] },
      ]),
    });
    await service.replaceSourceObjects({
      source_id: "clinical",
      expected_revision: "a".repeat(64),
      objects: [{ object_id: "visits", discovered_object_id: "table.dbo.visits" }],
    });
    expect(saved).toEqual([["clinical", [stored], "a".repeat(64)]]);
  });
  it("保存过程完整定义并使未配置定义的过程保持仅可发现", async () => {
    const saved: ExposedSourceObject[][] = [];
    const service = createService({
      exposedObjectWriter: {
        replaceForSource: async (_sourceId: string, objects: ExposedSourceObject[]) => {
          saved.push(objects);
        },
      },
      runtime: createRuntime([
        {
          kind: "stored_procedure",
          native_schema_name: "dbo",
          native_object_name: "report",
          columns: [],
        },
      ]),
    });
    const definition = {
      query_parameters: [],
      columns: [{ name: "id", data_type: "integer", nullable: false }],
    };
    await service.replaceSourceObjects({
      source_id: "clinical",
      objects: [{ object_id: "stored_procedure.dbo.report", procedure_definition: definition }],
    });
    await service.replaceSourceObjects({
      source_id: "clinical",
      objects: [{ object_id: "stored_procedure.dbo.report" }],
    });
    expect(saved[0]?.[0]).toMatchObject({ isQueryable: true, procedureDefinition: definition });
    expect(saved[1]?.[0]).toMatchObject({ isQueryable: false, isDiscoverable: true });
  });
  // 记录写入次数和失效请求的 secret_ref；密文内容的认证由 cipher 测试覆盖。
  it("保存共享凭据并失效依赖连接器", async () => {
    const saved: unknown[] = [];
    const invalidated: string[] = [];
    const service = createService({
      secretWriter: {
        async upsert(secret: EncryptedDataSourceSecret) {
          saved.push(secret);
        },
      },
      runtime: {
        ...createRuntime(),
        async invalidateBySecretRef(secretRef: string) {
          invalidated.push(secretRef);
        },
      },
    });

    await expect(
      service.saveSharedCredentials({
        secret_ref: "hospital-sqlserver-reader",
        connector_kind: "sqlserver",
        host: "10.0.0.15",
        port: 1433,
        user: "reader",
        password: "secret",
      }),
    ).resolves.toEqual({ secret_ref: "hospital-sqlserver-reader" });

    expect(saved).toHaveLength(1);
    expect(invalidated).toEqual(["hospital-sqlserver-reader"]);
  });

  it("通过共享凭据发现可访问数据库", async () => {
    const service = createService({
      targetDiscovery: {
        async listDatabaseTargets() {
          return [
            { name: "clinical_archive", connectTarget: "clinical_archive" },
            { name: "clinical_reporting", connectTarget: "clinical_reporting" },
          ];
        },
      },
    });

    await expect(
      service.discoverDatabaseTargets({
        secret_ref: "hospital-sqlserver-reader",
        connector_kind: "sqlserver",
      }),
    ).resolves.toEqual({
      databases: [
        { name: "clinical_archive", connect_target: "clinical_archive" },
        { name: "clinical_reporting", connect_target: "clinical_reporting" },
      ],
    });
  });

  it("通过 CDB 入口发现 Oracle PDB 服务", async () => {
    let discoveryInput: unknown;
    const service = createService({
      secretResolver: {
        async resolve() {
          return {
            connectorKind: "oracle" as const,
            host: "10.0.0.20",
            port: 1521,
            user: "reader",
            password: "secret",
          };
        },
      },
      targetDiscovery: {
        async listDatabaseTargets(_secret: unknown, input: unknown) {
          discoveryInput = input;
          return [
            {
              name: "CLINICAL_PDB",
              connectTarget: "clinical_pdb.company",
              connectType: "service_name" as const,
            },
          ];
        },
      },
    });

    await expect(
      service.discoverDatabaseTargets({
        secret_ref: "hospital-oracle-reader",
        connector_kind: "oracle",
        oracle_connect_type: "service_name",
        oracle_connect_target: "cdb.company",
      }),
    ).resolves.toEqual({
      databases: [
        {
          name: "CLINICAL_PDB",
          connect_target: "clinical_pdb.company",
          connect_type: "service_name",
        },
      ],
    });
    expect(discoveryInput).toEqual({
      oracleConnectType: "service_name",
      oracleConnectTarget: "cdb.company",
    });
  });

  it("保存一个目标库绑定的数据源", async () => {
    const saved: unknown[] = [];
    const invalidated: string[] = [];
    const service = createService({
      configWriter: {
        async upsert(config: DataSourceConfig, isEnabled: boolean) {
          saved.push({ config, isEnabled });
        },
      },
      runtime: {
        ...createRuntime(),
        async invalidate(sourceId: string) {
          invalidated.push(sourceId);
        },
      },
    });

    await expect(
      service.saveDataSource({
        source_id: "clinical_reporting",
        connector_kind: "sqlserver",
        secret_ref: "hospital-sqlserver-reader",
        target_database: "clinical_reporting",
        timeout_ms: 15000,
        connection_pool_limit: 10,
        concurrency_limit: 5,
        row_limit: 1000,
      }),
    ).resolves.toEqual({ source_id: "clinical_reporting" });

    expect(saved).toMatchObject([
      {
        config: {
          sourceId: "clinical_reporting",
          secretRef: "hospital-sqlserver-reader",
          targetDatabase: "clinical_reporting",
        },
        isEnabled: true,
      },
    ]);
    expect(invalidated).toEqual(["clinical_reporting"]);
  });

  it("保存一个 Oracle SID 连接目标", async () => {
    const saved: DataSourceConfig[] = [];
    const service = createService({
      configWriter: {
        async upsert(config: DataSourceConfig) {
          saved.push(config);
        },
      },
    });

    await expect(
      service.saveDataSource({
        source_id: "clinical_oracle",
        connector_kind: "oracle",
        secret_ref: "hospital-oracle-reader",
        oracle_connect_type: "sid",
        oracle_connect_target: "CLINICAL",
        timeout_ms: 15000,
        connection_pool_limit: 10,
        concurrency_limit: 5,
        row_limit: 1000,
        cost_limit: 50000,
      }),
    ).resolves.toEqual({ source_id: "clinical_oracle" });

    expect(saved).toEqual([
      expect.objectContaining({
        connectorKind: "oracle",
        oracleConnectType: "sid",
        oracleConnectTarget: "CLINICAL",
      }),
    ]);
  });

  // 本例选择目录里已有的表和存储过程，核对保存时使用的物理映射。
  it("验证对象属于当前目标库后替换白名单", async () => {
    const saved: unknown[] = [];
    const service = createService({
      exposedObjectWriter: {
        async replaceForSource(sourceId: string, objects: ExposedSourceObject[]) {
          saved.push({ sourceId, objects });
        },
      },
      runtime: createRuntime([
        {
          kind: "table",
          native_schema_name: "clinical",
          native_object_name: "patient_records",
          columns: [],
        },
        {
          kind: "stored_procedure",
          native_schema_name: "clinical",
          native_object_name: "refresh_summary",
          columns: [],
        },
      ]),
    });

    await expect(
      service.replaceSourceObjects({
        source_id: "clinical_reporting",
        objects: [
          { object_id: "table.clinical.patient_records" },
          { object_id: "stored_procedure.clinical.refresh_summary" },
        ],
      }),
    ).resolves.toEqual({ source_id: "clinical_reporting", object_count: 2 });

    expect(saved).toMatchObject([
      {
        sourceId: "clinical_reporting",
        objects: [
          {
            objectId: "table.clinical.patient_records",
            objectKind: "table",
            nativeSchemaName: "clinical",
            nativeObjectName: "patient_records",
          },
          {
            objectId: "stored_procedure.clinical.refresh_summary",
            objectKind: "stored_procedure",
            nativeSchemaName: "clinical",
            nativeObjectName: "refresh_summary",
          },
        ],
      },
    ]);
  });
});

/** 创建管理服务的最小依赖替身，可按场景覆盖单个依赖。 */
function createService(overrides: Record<string, unknown> = {}): DataSourceManagementService {
  return new DataSourceManagementService(
    {
      findBySecretRef: async () => undefined,
      replace: async (secret) => {
        await (
          overrides.secretWriter as
            { upsert(secret: EncryptedDataSourceSecret): Promise<void> } | undefined
        )?.upsert(secret);
        return true;
      },
    },
    (overrides.configWriter ?? { async upsert() {} }) as {
      upsert(config: never, isEnabled: boolean): Promise<void>;
    },
    (overrides.exposedObjectWriter ?? { async replaceForSource() {} }) as {
      replaceForSource(sourceId: string, objects: never[]): Promise<void>;
    },
    (overrides.secretResolver ?? createSecretResolver()) as DataSourceSecretResolver,
    (overrides.activeKeyProvider ?? createKeyProvider()) as ActiveMasterKeyProvider,
    new Aes256GcmSecretCipher(),
    (overrides.targetDiscovery ?? createTargetDiscovery()) as DatabaseTargetDiscovery,
    (overrides.runtime ?? createRuntime()) as never,
    (overrides.administration ?? {}) as never,
  );
}

/** 创建固定解析 SQL Server 共享凭据的替身。 */
function createSecretResolver(): DataSourceSecretResolver {
  return {
    async resolve() {
      return {
        connectorKind: "sqlserver",
        host: "10.0.0.15",
        port: 1433,
        user: "reader",
        password: "secret",
      };
    },
  };
}

/** 创建固定活动主密钥替身。 */
function createKeyProvider(): ActiveMasterKeyProvider {
  return {
    async getActiveKey() {
      return { keyId: "key_20260831", value: Buffer.alloc(32, 1) };
    },
    async getKey() {
      return Buffer.alloc(32, 1);
    },
  };
}

/** 创建默认不返回任何数据库的服务器目标发现替身。 */
function createTargetDiscovery(): DatabaseTargetDiscovery {
  return {
    async listDatabaseTargets() {
      return [];
    },
  };
}

/** 创建能提供固定对象目录和连接器失效方法的运行时替身。 */
function createRuntime(items: DiscoveredDataset[] = []) {
  return {
    async get() {
      return {
        async discoverCatalog() {
          return items;
        },
      };
    },
    async invalidate() {},
    async invalidateBySecretRef() {},
  };
}
