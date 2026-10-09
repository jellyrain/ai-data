import { createHash } from "node:crypto";
import {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  deleteDatabaseConnectionSchema,
  testDatabaseConnectionSchema,
  testDatabaseConnectionDraftSchema,
  databaseTargetDiscoveryRequestSchema,
  type TestDatabaseConnection,
} from "@ai-data/contracts";
import { parseSecretJson, type ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import type { EncryptedDataSourceSecret } from "../secrets/secret-types";
import type { DatabaseConnectionDependencies } from "./database-connection-types";
import { ManagementConflict } from "./management-conflict";

/** 可公开的管理失败，路由按稳定错误码返回，不带驱动连接详情。 */
class DatabaseConnectionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseConnectionError";
  }
}
/** 修订绑定密文，避免公开字段指纹泄漏密码或覆盖并发密码轮换。 */
function connectionRevision(secret: EncryptedDataSourceSecret) {
  return createHash("sha256")
    .update(secret.keyId)
    .update(secret.encryptedPayload)
    .update(JSON.stringify(secret.metadata))
    .digest("hex");
}
/** 数据库服务器连接的管理生命周期，业务目标库由数据源独立绑定。 */
class DatabaseConnectionService {
  constructor(private readonly dependencies: DatabaseConnectionDependencies) {}
  private async read(id: string) {
    const stored = await this.dependencies.repository.findBySecretRef(id);
    if (!stored) throw new DatabaseConnectionError("NOT_FOUND", "数据库连接不存在");
    const key = await this.dependencies.keys.getKey(stored.keyId);
    const value = parseSecretJson(
      this.dependencies.cipher.decrypt(
        { encryptedPayload: stored.encryptedPayload, metadata: stored.metadata },
        key,
      ),
    );
    return { stored, value };
  }
  async list() {
    const refs = await this.dependencies.administration.secrets();
    const items = [];
    for (const ref of refs.items.filter((item) => item.exists)) {
      const state = await this.read(ref.secret_ref);
      if (state.value.connectorKind !== "http_api") items.push(await this.get(ref.secret_ref));
    }
    return { items };
  }
  async get(id: string) {
    const { stored, value } = await this.read(id);
    if (value.connectorKind === "http_api")
      throw new DatabaseConnectionError("INVALID_INPUT", "此连接用于 HTTP API");
    const sources = (await this.dependencies.administration.sources()).items;
    return databaseConnectionSchema.parse({
      secret_ref: id,
      connector_kind: value.connectorKind,
      host: value.host,
      port: value.port,
      user: value.user,
      ...(value.connectorKind === "sqlserver" && value.sqlserver_transport
        ? { sqlserver_transport: value.sqlserver_transport }
        : {}),
      source_ids: sources
        .filter((source) => source.secret_ref === id)
        .map((source) => source.source_id),
      revision: connectionRevision(stored),
    });
  }
  private async encode(id: string, value: unknown): Promise<EncryptedDataSourceSecret> {
    const key = await this.dependencies.keys.getActiveKey();
    const encrypted = this.dependencies.cipher.encrypt(
      Buffer.from(JSON.stringify(value)),
      key.value,
    );
    return {
      secretRef: id,
      keyId: key.keyId,
      encryptedPayload: encrypted.encryptedPayload,
      metadata: encrypted.metadata,
    };
  }
  async create(input: unknown) {
    const { secret_ref, connector_kind, ...fields } = createDatabaseConnectionSchema.parse(input);
    const next = await this.encode(secret_ref, { connectorKind: connector_kind, ...fields });
    if (!(await this.dependencies.repository.replace(next, undefined)))
      throw new DatabaseConnectionError("CONFLICT", "数据库连接名称已存在");
    return this.get(secret_ref);
  }
  async update(id: string, input: unknown) {
    const { expected_revision, password, sqlserver_transport, ...fields } =
      updateDatabaseConnectionSchema.parse(input);
    const { stored, value } = await this.read(id);
    if (connectionRevision(stored) !== expected_revision) throw new ManagementConflict();
    if (
      value.connectorKind === "http_api" ||
      (sqlserver_transport && value.connectorKind !== "sqlserver")
    )
      throw new DatabaseConnectionError("INVALID_INPUT", "数据库连接类型与选项不匹配");
    const next = await this.encode(id, {
      ...value,
      ...fields,
      password: password || value.password,
      ...(sqlserver_transport ? { sqlserver_transport } : {}),
    });
    if (!(await this.dependencies.repository.replace(next, stored))) throw new ManagementConflict();
    await this.dependencies.runtime.invalidateBySecretRef(id);
    return this.get(id);
  }
  async remove(id: string, input: unknown) {
    const { expected_revision } = deleteDatabaseConnectionSchema.parse(input);
    const { stored, value } = await this.read(id);
    if (value.connectorKind === "http_api")
      throw new DatabaseConnectionError("INVALID_INPUT", "此连接用于 HTTP API");
    if (connectionRevision(stored) !== expected_revision) throw new ManagementConflict();
    await this.dependencies.administration.deleteConnection(stored);
    await this.dependencies.runtime.invalidateBySecretRef(id);
    return { secret_ref: id };
  }
  async test(id: string, input: unknown) {
    const options = testDatabaseConnectionSchema.parse(input);
    const { value } = await this.read(id);
    if (value.connectorKind === "http_api")
      throw new DatabaseConnectionError("INVALID_INPUT", "此连接用于 HTTP API");
    const request = databaseTargetDiscoveryRequestSchema.parse({
      secret_ref: id,
      connector_kind: value.connectorKind,
      ...options,
    });
    return this.discover(value, request);
  }
  /** 测试仅在内存中组合草稿和已保存密码，失败或成功均不写入元数据库。 */
  async testDraft(input: unknown) {
    const {
      saved_connection,
      connector_kind,
      password,
      sqlserver_transport,
      oracle_connect_type,
      oracle_connect_target,
      ...fields
    } = testDatabaseConnectionDraftSchema.parse(input);
    let previous: ResolvedDataSourceSecret | undefined;
    if (saved_connection) {
      const { stored, value } = await this.read(saved_connection.secret_ref);
      if (connectionRevision(stored) !== saved_connection.expected_revision)
        throw new ManagementConflict();
      if (value.connectorKind !== connector_kind)
        throw new DatabaseConnectionError("INVALID_INPUT", "数据库连接类型与测试参数不匹配");
      previous = value;
    }
    const transport =
      sqlserver_transport ??
      (previous?.connectorKind === "sqlserver" ? previous.sqlserver_transport : undefined);
    const value = parseSecretJson(
      Buffer.from(
        JSON.stringify({
          connectorKind: connector_kind,
          ...fields,
          password:
            password ||
            (previous && previous.connectorKind !== "http_api" ? previous.password : undefined),
          ...(transport ? { sqlserver_transport: transport } : {}),
        }),
      ),
    );
    return this.discover(value, { oracle_connect_type, oracle_connect_target });
  }
  private async discover(value: ResolvedDataSourceSecret, request: TestDatabaseConnection) {
    if (value.connectorKind === "http_api")
      throw new DatabaseConnectionError("INVALID_INPUT", "此连接用于 HTTP API");
    const targets = await this.dependencies.discovery.listDatabaseTargets(value, {
      ...(request.oracle_connect_type ? { oracleConnectType: request.oracle_connect_type } : {}),
      ...(request.oracle_connect_target
        ? { oracleConnectTarget: request.oracle_connect_target }
        : {}),
    });
    return {
      databases: targets.map((target) => ({
        name: target.name,
        connect_target: target.connectTarget,
        ...(target.connectType ? { connect_type: target.connectType } : {}),
      })),
    };
  }
}
export { DatabaseConnectionService, DatabaseConnectionError, connectionRevision };
