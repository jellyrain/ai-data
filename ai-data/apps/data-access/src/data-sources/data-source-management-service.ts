import { createHash } from "node:crypto";
import {
  dataSourceManagementConfigSchema,
  deleteDataSourceSchema,
  databaseTargetDiscoveryRequestSchema,
  sharedDatabaseCredentialsSchema,
  sourceObjectDiscoveryRequestSchema,
  sourceObjectSelectionRequestSchema,
  sqlServerTransportUpdateSchema,
  managedSqlServerTransportSchema,
} from "@ai-data/contracts";
import type { ManageableSourceObject } from "@ai-data/contracts";
import type { z } from "zod";
import { publicSourceObject } from "../metadata/sql-data-source-administration";
import type { SqlDataSourceAdministration } from "../metadata/sql-data-source-administration";
import { managedObjectCapabilities } from "./managed-object-capabilities";

import type { DiscoveredDataset } from "../connectors/connector-catalog";
import type { EncryptedDataSourceSecret } from "../secrets/secret-types";
import type { DataSourceConfig } from "./data-source-types";
import type { ExposedSourceObject } from "../catalog/catalog-types";
import type { Aes256GcmSecretCipher, ActiveMasterKeyProvider } from "@ai-data/metadata/secrets";
import type { DataSourceSecretResolver } from "../secrets/secret-resolver";
import type { DatabaseTargetDiscovery } from "./database-target-discovery";
import { parseSecretJson } from "../secrets/secret-resolver";
import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import type { DasConfig } from "../config/das-config";
import { resolveSqlServerTransport } from "../connectors/sqlserver-transport";
import { ManagementConflict } from "./management-conflict";
import { DatabaseConnectionService, DatabaseConnectionError } from "./database-connection-service";

/** 共享密文的写入能力。 */
interface DataSourceSecretWriter {
  findBySecretRef(secretRef: string): Promise<EncryptedDataSourceSecret | undefined>;
  /** 只有持久化密文仍与读取基准一致才保存。 */
  replace(
    secret: EncryptedDataSourceSecret,
    previous: EncryptedDataSourceSecret | undefined,
  ): Promise<boolean>;
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

/** 为 API 管理接口提供凭据、目标库、对象发现与白名单保存能力。 */
class DataSourceManagementService {
  readonly connections: DatabaseConnectionService;
  constructor(
    private readonly secretWriter: DataSourceSecretWriter,
    _configWriter: DataSourceConfigWriter,
    private readonly exposedObjectWriter: ExposedObjectWriter,
    private readonly secretResolver: DataSourceSecretResolver,
    private readonly activeKeyProvider: ActiveMasterKeyProvider,
    private readonly cipher: Aes256GcmSecretCipher,
    private readonly targetDiscovery: DatabaseTargetDiscovery,
    private readonly runtime: ManagedDataSourceRuntime,
    private readonly administration: Pick<
      SqlDataSourceAdministration,
      | "sources"
      | "source"
      | "objects"
      | "secrets"
      | "saveSource"
      | "saveObjects"
      | "deleteConnection"
      | "deleteSource"
      | "saveConnectedSource"
    >,
    private readonly sqlServerTransports: NonNullable<DasConfig["sqlserver_transports"]> = {},
  ) {
    this.connections = new DatabaseConnectionService({
      repository: secretWriter,
      administration,
      keys: activeKeyProvider,
      cipher,
      discovery: targetDiscovery,
      runtime,
    });
  }

  /** 管理回读直接访问公开配置，不创建业务连接。 */
  async listDataSources() {
    return this.administration.sources();
  }
  async getDataSource(sourceId: string) {
    return this.administration.source(sourceId);
  }
  async listSecretReferences() {
    return this.administration.secrets();
  }
  async getSourceObjects(sourceId: string) {
    const result = await this.administration.objects(sourceId);
    return { ...result, items: result.items.map(publicSourceObject) };
  }

  /** 加密保存可复用的数据库服务器凭据，并刷新依赖该凭据的运行连接器。 */
  async saveSharedCredentials(input: unknown): Promise<{ secret_ref: string }> {
    const credentials = sharedDatabaseCredentialsSchema.parse(input);
    // 完整凭据更新省略新参数时保留最新已存值；并发变化后重新读取并合并。
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await this.secretWriter.findBySecretRef(credentials.secret_ref);
      const existing = previous ? await this.decodeSecret(previous) : undefined;
      if (existing && existing.connectorKind !== credentials.connector_kind)
        throw new DatabaseConnectionError(
          "INVALID_INPUT",
          "数据库连接类型创建后保持固定，请新建连接",
        );
      const transport =
        credentials.connector_kind === "sqlserver"
          ? (credentials.sqlserver_transport ??
            (existing?.connectorKind === "sqlserver" ? existing.sqlserver_transport : undefined))
          : undefined;
      const value = {
        connectorKind: credentials.connector_kind,
        host: credentials.host,
        port: credentials.port,
        user: credentials.user,
        password: credentials.password,
        ...(transport ? { sqlserver_transport: transport } : {}),
      };
      const next = await this.encodeSecret(credentials.secret_ref, value);
      if (await this.secretWriter.replace(next, previous)) {
        await this.runtime.invalidateBySecretRef(credentials.secret_ref);
        return { secret_ref: credentials.secret_ref };
      }
    }
    throw new ManagementConflict();
  }

  /** 仅回传连接选项、来源和密文修订；关联源的文件回退单独列出。 */
  async getSqlServerTransport(secretRef: string) {
    const { stored, value } = await this.sqlServerSecret(secretRef);
    const current = resolveSqlServerTransport(value.sqlserver_transport);
    const sources = (await this.administration.sources()).items.filter(
      (source) => source.secret_ref === secretRef,
    );
    return managedSqlServerTransportSchema.parse({
      secret_ref: secretRef,
      connector_kind: "sqlserver",
      sqlserver_transport: current.options,
      origin: current.origin,
      revision: secretRevision(stored),
      sources: sources.map((source) => {
        const deployment = Object.hasOwn(this.sqlServerTransports, source.source_id)
          ? this.sqlServerTransports[source.source_id]
          : undefined;
        const resolved = resolveSqlServerTransport(value.sqlserver_transport, deployment);
        return {
          source_id: source.source_id,
          sqlserver_transport: resolved.options,
          origin: resolved.origin,
        };
      }),
    });
  }

  /** 参数更新绑定读取的整份密文，保留密码并拒绝陈旧的比较基准。 */
  async saveSqlServerTransport(secretRef: string, input: unknown) {
    const update = sqlServerTransportUpdateSchema.parse(input);
    const { stored, value } = await this.sqlServerSecret(secretRef);
    if (secretRevision(stored) !== update.expected_revision) throw new ManagementConflict();
    const next = await this.encodeSecret(secretRef, {
      ...value,
      sqlserver_transport: update.sqlserver_transport,
    });
    if (!(await this.secretWriter.replace(next, stored))) throw new ManagementConflict();
    await this.runtime.invalidateBySecretRef(secretRef);
    return this.getSqlServerTransport(secretRef);
  }

  private async sqlServerSecret(secretRef: string) {
    const stored = await this.secretWriter.findBySecretRef(secretRef);
    if (!stored) throw new Error("凭据不存在");
    const value = await this.decodeSecret(stored);
    if (value.connectorKind !== "sqlserver") throw new Error("此凭据不是 SQL Server 类型");
    return { stored, value };
  }

  private async decodeSecret(stored: EncryptedDataSourceSecret): Promise<ResolvedDataSourceSecret> {
    const key = await this.activeKeyProvider.getKey(stored.keyId);
    return parseSecretJson(
      this.cipher.decrypt(
        { encryptedPayload: stored.encryptedPayload, metadata: stored.metadata },
        key,
      ),
    );
  }

  private async encodeSecret(
    secretRef: string,
    value: unknown,
  ): Promise<EncryptedDataSourceSecret> {
    const key = await this.activeKeyProvider.getActiveKey();
    const encrypted = this.cipher.encrypt(Buffer.from(JSON.stringify(value), "utf8"), key.value);
    return {
      secretRef,
      keyId: key.keyId,
      encryptedPayload: encrypted.encryptedPayload,
      metadata: encrypted.metadata,
    };
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
    const connection = await this.connections.get(value.secret_ref);
    if (connection.connector_kind !== value.connector_kind)
      throw new DatabaseConnectionError("INVALID_INPUT", "数据源类型必须与数据库连接一致");
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
      costLimit: value.cost_limit ?? 1,
    };
    await this.administration.saveConnectedSource(
      config,
      value.is_enabled,
      connection.revision,
      value.expected_revision,
    );
    await this.runtime.invalidate(config.sourceId);
    return { source_id: config.sourceId };
  }

  /** 删除在元数据库事务提交后释放旧运行连接，业务数据库不参与写入。 */
  async deleteDataSource(input: unknown): Promise<{ source_id: string }> {
    const value = deleteDataSourceSchema.parse(input);
    await this.administration.deleteSource(
      value.source_id,
      value.expected_revision,
      value.expected_objects_revision,
    );
    await this.runtime.invalidate(value.source_id);
    return { source_id: value.source_id };
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

    // 保存前重新发现目录，使用服务器返回的物理映射，防止旧选择指向已变化的对象。
    const available = await this.discoverSourceObjects({ source_id: request.source_id });
    const availableByObjectId = new Map(available.items.map((item) => [item.object_id, item]));
    const current =
      request.expected_revision === undefined
        ? []
        : (await this.administration.objects(request.source_id)).items;
    const objects = [...selectedObjectIds].map((objectId) => {
      const selection = request.objects.find((item) => item.object_id === objectId)!;
      const previous = current.find((item) => item.objectId === objectId);
      const discoveredId =
        selection.discovered_object_id ??
        (previous
          ? [previous.objectKind, previous.nativeSchemaName, previous.nativeObjectName]
              .filter((value) => value !== undefined)
              .join(".")
          : objectId);
      const object = availableByObjectId.get(discoveredId);
      if (object === undefined) {
        throw new Error(`对象不属于当前数据源目录: ${objectId}`);
      }
      if (
        previous &&
        (previous.objectKind !== object.kind ||
          previous.nativeSchemaName !== object.native_schema_name ||
          previous.nativeObjectName !== object.native_object_name)
      )
        throw new Error("已有逻辑对象不能重映射到其他物理对象");
      const definition =
        selection.procedure_definition === null
          ? undefined
          : (selection.procedure_definition ?? previous?.procedureDefinition);
      if (definition !== undefined && object.kind !== "stored_procedure") {
        throw new Error("只有存储过程可以配置过程定义");
      }
      return {
        sourceId: request.source_id,
        objectId,
        objectKind: object.kind,
        ...(object.native_schema_name === undefined
          ? {}
          : { nativeSchemaName: object.native_schema_name }),
        nativeObjectName: object.native_object_name,
        isDiscoverable: selection.is_discoverable ?? previous?.isDiscoverable ?? true,
        isQueryable:
          (selection.is_queryable ?? previous?.isQueryable ?? true) &&
          (object.kind !== "stored_procedure" || definition !== undefined),
        queryCapabilities: managedObjectCapabilities(
          object,
          selection.query_capabilities ?? previous?.queryCapabilities ?? {},
        ),
        ...(definition === undefined ? {} : { procedureDefinition: definition }),
      } satisfies ExposedSourceObject;
    });
    if (request.expected_revision === undefined)
      await this.exposedObjectWriter.replaceForSource(request.source_id, objects);
    else
      await this.administration.saveObjects(request.source_id, objects, request.expected_revision);
    return { source_id: request.source_id, object_count: objects.length };
  }
}

/** 为共享凭据解析构造临时配置；这些资源值只用于满足类型形态，不创建业务连接器。 */
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
    ...(dataset.query_capabilities === undefined
      ? {}
      : { query_capabilities: dataset.query_capabilities }),
  };
}

/** 修订只由密文、认证标签及密钥标识生成，不以登录资料作为公开指纹输入。 */
function secretRevision(secret: EncryptedDataSourceSecret): string {
  return createHash("sha256")
    .update(secret.keyId)
    .update(secret.encryptedPayload)
    .update(JSON.stringify(secret.metadata))
    .digest("hex");
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
