import { z } from "zod";

import type { DiscoveredDataset } from "../connectors/connector-catalog";
import {
  type EncryptedDataSourceSecret,
  type DataSourceConfig,
  type ExposedSourceObject,
} from "../metadata/metadata-records";
import { Aes256GcmSecretCipher } from "../secrets/aes-256-gcm-secret-cipher";
import type { ActiveMasterKeyProvider } from "../secrets/local-master-key-store";
import type { DataSourceSecretResolver } from "../secrets/secret-resolver";
import type { DatabaseTargetDiscovery } from "./database-target-discovery";

/** 数据库连接器可保存的共享凭据类型。 */
const databaseConnectorKindSchema = z.enum(["sqlserver", "mysql", "postgresql", "oracle"]);

/** 管理端保存一套可由多个 source_id 复用的数据库服务器凭据。 */
const sharedDatabaseCredentialsSchema = z
  .object({
    /** 多个目标库可复用的加密凭据引用。 */
    secret_ref: z.string().min(1),
    /** 此凭据对应的数据库驱动类型。 */
    connector_kind: databaseConnectorKindSchema,
    /** 数据库服务器主机名或 IP 地址。 */
    host: z.string().min(1),
    /** 数据库服务器 TCP 端口。 */
    port: z.number().int().min(1).max(65535),
    /** 只读登录账号。 */
    user: z.string().min(1),
    /** 只在加密写入和连接创建期间使用的登录密码。 */
    password: z.string().min(1),
  })
  .strict();

/** 管理端按共享凭据发现可绑定目标库的请求。 */
const databaseTargetDiscoveryRequestSchema = z
  .object({
    /** 已保存的共享凭据引用。 */
    secret_ref: z.string().min(1),
    /** 用于选择目标库目录读取方式的数据库类型。 */
    connector_kind: databaseConnectorKindSchema,
    /** Oracle 发现必须先连接 CDB；其他数据库不使用该字段。 */
    oracle_connect_type: z.enum(["sid", "service_name"]).optional(),
    /** Oracle CDB 的 SID 或 Service Name。 */
    oracle_connect_target: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasOracleTarget =
      value.oracle_connect_type !== undefined || value.oracle_connect_target !== undefined;
    if (
      value.connector_kind === "oracle" &&
      (value.oracle_connect_type === undefined || value.oracle_connect_target === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Oracle 目标发现必须配置 CDB 的 SID 或 Service Name",
      });
    }
    if (value.connector_kind !== "oracle" && hasOracleTarget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "非 Oracle 数据库不能配置 Oracle 连接目标",
      });
    }
  });

/** 管理端保存一个只绑定单一目标数据库或 Oracle 连接目标的数据源。 */
const dataSourceManagementConfigSchema = z
  .object({
    /** 单一目标数据库的运行数据源标识。 */
    source_id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
    /** 当前 source_id 使用的数据库连接器。 */
    connector_kind: databaseConnectorKindSchema,
    /** 指向共享服务器凭据的加密记录。 */
    secret_ref: z.string().min(1),
    /** SQL Server、MySQL 或 PostgreSQL 实际连接的目标数据库。 */
    target_database: z.string().min(1).optional(),
    /** Oracle 目标使用 SID 或 Service Name。 */
    oracle_connect_type: z.enum(["sid", "service_name"]).optional(),
    /** Oracle 目标的 SID 或 Service Name。 */
    oracle_connect_target: z.string().min(1).optional(),
    /** 是否允许创建当前 source_id 的运行时连接器。 */
    is_enabled: z.boolean().default(true),
    /** 单次请求允许占用业务连接的最长时间，单位毫秒。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 当前 source_id 独立连接池的最大连接数。 */
    connection_pool_limit: z.number().int().min(1).max(100),
    /** 当前 source_id 同时执行的最大请求数。 */
    concurrency_limit: z.number().int().min(1).max(1000),
    /** 当前 source_id 单次响应允许返回的最大行数。 */
    row_limit: z.number().int().min(1).max(5000),
    /** 查询规划器可使用的成本预算。 */
    cost_limit: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.connector_kind === "oracle") {
      if (value.oracle_connect_type === undefined || value.oracle_connect_target === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Oracle 数据源必须配置 oracle_connect_type 和 oracle_connect_target",
        });
      }
      if (value.target_database !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_database"],
          message: "Oracle 数据源不能配置 target_database",
        });
      }
      return;
    }

    if (value.target_database === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_database"],
        message: "数据库数据源必须配置 target_database",
      });
    }
    if (value.oracle_connect_type !== undefined || value.oracle_connect_target !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "数据库数据源不能配置 Oracle 连接目标",
      });
    }
  });

/** 管理端请求展开一个已保存 source_id 的完整业务对象目录。 */
const sourceObjectDiscoveryRequestSchema = z
  .object({
    /** 需要展开完整对象目录的已保存数据源。 */
    source_id: z.string().min(1),
  })
  .strict();

/** 管理端提交的对象白名单选择项。 */
const sourceObjectSelectionSchema = z
  .object({
    /** 管理端从当前数据源目录中勾选的对象标识。 */
    object_id: z.string().min(1),
  })
  .strict();

/** 管理端替换一个 source_id 的 API 对象白名单。 */
const sourceObjectSelectionRequestSchema = z
  .object({
    /** 要替换白名单的已保存数据源。 */
    source_id: z.string().min(1),
    /** 本次应暴露给 API 的完整对象集合。 */
    objects: z.array(sourceObjectSelectionSchema),
  })
  .strict();

/** 共享密文的写入能力。 */
interface DataSourceSecretWriter {
  /** 保存或更新加密后的共享凭据。 */
  upsert(secret: EncryptedDataSourceSecret): Promise<void>;
}

/** 单库数据源配置的写入能力。 */
interface DataSourceConfigWriter {
  /** 保存或更新一个 source_id 的运行配置。 */
  upsert(config: DataSourceConfig, isEnabled: boolean): Promise<void>;
}

/** API 对象白名单的写入能力。 */
interface ExposedObjectWriter {
  /** 以本次管理员选择替换一个数据源的对象白名单。 */
  replaceForSource(sourceId: string, objects: ExposedSourceObject[]): Promise<void>;
}

/** 管理服务使用的运行时连接器能力。 */
interface ManagedDataSourceRuntime {
  /** 获取单一 source_id 绑定的运行时连接器。 */
  get(sourceId: string): Promise<{ discoverCatalog(): Promise<DiscoveredDataset[]> }>;
  /** 配置变更后关闭该 source_id 的旧连接器。 */
  invalidate(sourceId: string): Promise<void>;
  /** 密文变更后关闭全部使用该密文的旧连接器。 */
  invalidateBySecretRef(secretRef: string): Promise<void>;
}

/** 管理端展开后展示并可勾选的数据库对象。 */
type ManageableSourceObject = Pick<
  DiscoveredDataset,
  "kind" | "native_schema_name" | "native_object_name" | "source_description" | "columns"
> & {
  /** 用于本次管理选择与保存白名单的稳定逻辑对象标识。 */
  object_id: string;
};

/** 为 API 管理接口提供凭据、目标库、对象发现与白名单保存能力。 */
class DataSourceManagementService {
  constructor(
    private readonly secretWriter: DataSourceSecretWriter,
    private readonly configWriter: DataSourceConfigWriter,
    private readonly exposedObjectWriter: ExposedObjectWriter,
    private readonly secretResolver: DataSourceSecretResolver,
    private readonly activeKeyProvider: ActiveMasterKeyProvider,
    private readonly cipher: Aes256GcmSecretCipher,
    private readonly targetDiscovery: DatabaseTargetDiscovery,
    private readonly runtime: ManagedDataSourceRuntime,
  ) {}

  /** 加密保存可复用的数据库服务器凭据，并刷新依赖该凭据的运行连接器。 */
  async saveSharedCredentials(input: unknown): Promise<{ secret_ref: string }> {
    const credentials = sharedDatabaseCredentialsSchema.parse(input);
    const activeKey = await this.activeKeyProvider.getActiveKey();
    const encrypted = this.cipher.encrypt(
      Buffer.from(
        JSON.stringify({
          connectorKind: credentials.connector_kind,
          host: credentials.host,
          port: credentials.port,
          user: credentials.user,
          password: credentials.password,
        }),
        "utf8",
      ),
      activeKey.value,
    );
    await this.secretWriter.upsert({
      secretRef: credentials.secret_ref,
      keyId: activeKey.keyId,
      encryptedPayload: encrypted.encryptedPayload,
      metadata: encrypted.metadata,
    });
    await this.runtime.invalidateBySecretRef(credentials.secret_ref);
    return { secret_ref: credentials.secret_ref };
  }

  /** 使用已保存共享凭据列出当前登录可访问的目标数据库。 */
  async discoverDatabaseTargets(input: unknown): Promise<{
    databases: Array<{
      name: string;
      connect_target: string;
      connect_type?: "sid" | "service_name";
    }>;
  }> {
    const request = databaseTargetDiscoveryRequestSchema.parse(input);
    const secret = await this.secretResolver.resolve(toResolutionConfig(request));
    if (secret.connectorKind === "http_api") {
      throw new Error("HTTP API 凭据不能发现数据库目标");
    }
    const targets = await this.targetDiscovery.listDatabaseTargets(secret, {
      ...(request.oracle_connect_type === undefined
        ? {}
        : { oracleConnectType: request.oracle_connect_type }),
      ...(request.oracle_connect_target === undefined
        ? {}
        : { oracleConnectTarget: request.oracle_connect_target }),
    });
    return {
      databases: targets.map((target) => ({
        name: target.name,
        connect_target: target.connectTarget,
        ...(target.connectType === undefined ? {} : { connect_type: target.connectType }),
      })),
    };
  }

  /** 保存一个 source_id 到其唯一的目标数据库或 Oracle 服务名绑定。 */
  async saveDataSource(input: unknown): Promise<{ source_id: string }> {
    const value = dataSourceManagementConfigSchema.parse(input);
    const config: DataSourceConfig = {
      sourceId: value.source_id,
      connectorKind: value.connector_kind,
      secretRef: value.secret_ref,
      ...(value.target_database === undefined ? {} : { targetDatabase: value.target_database }),
      ...(value.oracle_connect_type === undefined
        ? {}
        : { oracleConnectType: value.oracle_connect_type }),
      ...(value.oracle_connect_target === undefined
        ? {}
        : { oracleConnectTarget: value.oracle_connect_target }),
      timeoutMs: value.timeout_ms,
      connectionPoolLimit: value.connection_pool_limit,
      concurrencyLimit: value.concurrency_limit,
      rowLimit: value.row_limit,
      costLimit: value.cost_limit,
    };
    await this.configWriter.upsert(config, value.is_enabled);
    await this.runtime.invalidate(config.sourceId);
    return { source_id: config.sourceId };
  }

  /** 读取一个已保存数据源的完整对象目录，供管理员展开和勾选。 */
  async discoverSourceObjects(input: unknown): Promise<{ items: ManageableSourceObject[] }> {
    const request = sourceObjectDiscoveryRequestSchema.parse(input);
    const connector = await this.runtime.get(request.source_id);
    const items = await connector.discoverCatalog();
    return { items: items.map((item) => toManageableSourceObject(item)) };
  }

  /** 验证勾选对象仍存在于当前目标库后替换该 source_id 的 API 白名单。 */
  async replaceSourceObjects(input: unknown): Promise<{ source_id: string; object_count: number }> {
    const request = sourceObjectSelectionRequestSchema.parse(input);
    const selectedObjectIds = new Set(request.objects.map((item) => item.object_id));
    if (selectedObjectIds.size !== request.objects.length) {
      throw new Error("对象白名单不能重复选择同一对象");
    }

    const available = await this.discoverSourceObjects({ source_id: request.source_id });
    const availableByObjectId = new Map(available.items.map((item) => [item.object_id, item]));
    const objects = [...selectedObjectIds].map((objectId) => {
      const object = availableByObjectId.get(objectId);
      if (object === undefined) {
        throw new Error(`对象不属于当前数据源目录: ${objectId}`);
      }
      return {
        sourceId: request.source_id,
        objectId: object.object_id,
        objectKind: object.kind,
        ...(object.native_schema_name === undefined
          ? {}
          : { nativeSchemaName: object.native_schema_name }),
        nativeObjectName: object.native_object_name,
        isDiscoverable: true,
        isQueryable: true,
        queryCapabilities: {},
      } satisfies ExposedSourceObject;
    });
    await this.exposedObjectWriter.replaceForSource(request.source_id, objects);
    return { source_id: request.source_id, object_count: objects.length };
  }
}

/** 为凭据解析器构造仅用于验证连接器类型的最小配置。 */
function toResolutionConfig(
  request: z.infer<typeof databaseTargetDiscoveryRequestSchema>,
): DataSourceConfig {
  return {
    sourceId: `management.${request.secret_ref}`,
    connectorKind: request.connector_kind,
    secretRef: request.secret_ref,
    timeoutMs: 15000,
    connectionPoolLimit: 1,
    concurrencyLimit: 1,
    rowLimit: 1,
    costLimit: 1,
  };
}

/** 将连接器目录对象转换为管理端可勾选的稳定标识。 */
function toManageableSourceObject(dataset: DiscoveredDataset): ManageableSourceObject {
  return {
    object_id: [dataset.kind, dataset.native_schema_name, dataset.native_object_name]
      .filter((value): value is string => value !== undefined)
      .join("."),
    kind: dataset.kind,
    ...(dataset.native_schema_name === undefined
      ? {}
      : { native_schema_name: dataset.native_schema_name }),
    native_object_name: dataset.native_object_name,
    ...(dataset.source_description === undefined
      ? {}
      : { source_description: dataset.source_description }),
    columns: dataset.columns,
  };
}

export {
  DataSourceManagementService,
  dataSourceManagementConfigSchema,
  databaseTargetDiscoveryRequestSchema,
  sharedDatabaseCredentialsSchema,
  sourceObjectDiscoveryRequestSchema,
  sourceObjectSelectionRequestSchema,
};
export type {
  DataSourceConfigWriter,
  DataSourceSecretWriter,
  ExposedObjectWriter,
  ManageableSourceObject,
  ManagedDataSourceRuntime,
};
