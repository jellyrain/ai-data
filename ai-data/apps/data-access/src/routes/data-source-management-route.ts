import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  managedDataSourceSchema,
  deleteDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSourceObjectsSchema,
  managedSecretReferenceSchema,
  type ManagedDataSource,
  type ManagedDataSourceDetail,
  type ManagedSourceObjects,
  type ManagedSecretReference,
  managedSqlServerTransportSchema,
  sqlServerTransportUpdateSchema,
  type ManagedSqlServerTransport,
} from "@ai-data/contracts";
import { ManagementConflict } from "../data-sources/management-conflict";
import { sendInvalidInput } from "./contract-error";
import { internalServiceAuth } from "./internal-auth";
import {
  DatabaseConnectionError,
  type DatabaseConnectionService,
} from "../data-sources/database-connection-service";
import {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  deleteDatabaseConnectionSchema,
  testDatabaseConnectionSchema,
  testDatabaseConnectionDraftSchema,
  databaseTargetSchema,
} from "@ai-data/contracts";
import type { InternalServiceVerifier } from "../auth/internal-service-verifier";

/** 数据源管理路由需要的最小服务能力。 */
interface DataSourceManagementApi {
  connections: Pick<
    DatabaseConnectionService,
    "list" | "get" | "create" | "update" | "remove" | "test" | "testDraft"
  >;
  /** 元数据库公开配置读取，包含已停用源。 */
  listDataSources(): Promise<{ items: ManagedDataSource[] }>;
  getDataSource(sourceId: string): Promise<ManagedDataSourceDetail>;
  getSourceObjects(sourceId: string): Promise<ManagedSourceObjects>;
  listSecretReferences(): Promise<{ items: ManagedSecretReference[] }>;
  getSqlServerTransport(secretRef: string): Promise<ManagedSqlServerTransport>;
  saveSqlServerTransport(secretRef: string, input: unknown): Promise<ManagedSqlServerTransport>;
  /** 保存共享数据库服务器凭据。 */
  saveSharedCredentials(input: unknown): Promise<{ secret_ref: string }>;
  /** 发现共享凭据可访问的目标数据库。 */
  discoverDatabaseTargets(input: unknown): Promise<{
    databases: Array<{
      name: string;
      connect_target: string;
      connect_type?: "sid" | "service_name";
    }>;
  }>;
  /** 保存一个单库 source_id。 */
  saveDataSource(input: unknown): Promise<{ source_id: string }>;
  deleteDataSource(input: unknown): Promise<{ source_id: string }>;
  /** 发现一个 source_id 的完整对象目录。 */
  discoverSourceObjects(input: unknown): Promise<unknown>;
  /** 替换一个 source_id 的 API 对象白名单。 */
  replaceSourceObjects(input: unknown): Promise<{ source_id: string; object_count: number }>;
}

/** 注册供 API 管理端调用的数据源配置、发现和对象白名单接口。 */
function registerDataSourceManagementRoutes(
  app: FastifyInstance,
  managementService: DataSourceManagementApi,
  verifier?: Pick<InternalServiceVerifier, "verify">,
): void {
  const options = { preHandler: internalServiceAuth("das_management", verifier) };
  const empty = z.object({}).strict();
  const params = z.object({ sourceId: z.string().min(1).max(128) }).strict();
  const secretParams = z.object({ secretRef: z.string().min(1).max(256) }).strict();
  for (const [method, suffix, operation] of [
    ["GET", "", "list"],
    ["POST", "", "create"],
    ["POST", "/test", "test-draft"],
    ["GET", "/:secretRef", "get"],
    ["PUT", "/:secretRef", "update"],
    ["POST", "/:secretRef/delete", "remove"],
    ["POST", "/:secretRef/test", "test"],
  ] as const)
    app.route({
      method,
      url: `/internal/admin/database-connections${suffix}`,
      ...options,
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        empty.parse(request.query);
        const id =
          suffix && operation !== "test-draft" ? secretParams.parse(request.params).secretRef : "";
        try {
          const connections = managementService.connections;
          if (operation === "list")
            return readConfiguration(
              () => connections.list(),
              z.object({ items: z.array(databaseConnectionSchema) }).strict(),
            );
          if (operation === "get") {
            const value = await connections.get(id);
            return readConfiguration(async () => value, databaseConnectionSchema);
          }
          if (operation === "create")
            return databaseConnectionSchema.parse(
              await connections.create(createDatabaseConnectionSchema.parse(request.body)),
            );
          if (operation === "update")
            return databaseConnectionSchema.parse(
              await connections.update(id, updateDatabaseConnectionSchema.parse(request.body)),
            );
          if (operation === "remove")
            return await connections.remove(id, deleteDatabaseConnectionSchema.parse(request.body));
          return z
            .object({ databases: z.array(databaseTargetSchema) })
            .strict()
            .parse(
              operation === "test-draft"
                ? await connections.testDraft(testDatabaseConnectionDraftSchema.parse(request.body))
                : await connections.test(id, testDatabaseConnectionSchema.parse(request.body)),
            );
        } catch (error) {
          if (
            error instanceof z.ZodError ||
            error instanceof DatabaseConnectionError ||
            error instanceof ManagementConflict ||
            operation === "test" ||
            operation === "test-draft"
          )
            return sendManagementError(reply, request, error);
          // 写后回读或连接池刷新失败可能已经提交，客户端通过回读核对。
          throw new Error("数据库连接管理失败", { cause: error });
        }
      },
    });
  app.get(
    "/internal/admin/data-source-secrets/:secretRef/sqlserver-transport",
    options,
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      empty.parse(request.query);
      const { secretRef } = secretParams.parse(request.params);
      return readConfiguration(
        () => managementService.getSqlServerTransport(secretRef),
        managedSqlServerTransportSchema,
      );
    },
  );
  app.put(
    "/internal/admin/data-source-secrets/:secretRef/sqlserver-transport",
    options,
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      empty.parse(request.query);
      const { secretRef } = secretParams.parse(request.params);
      const input = sqlServerTransportUpdateSchema.parse(request.body);
      try {
        const value = await managementService.saveSqlServerTransport(secretRef, input);
        return await readConfiguration(async () => value, managedSqlServerTransportSchema);
      } catch (error) {
        if (error instanceof ManagementConflict) return sendManagementError(reply, request, error);
        // 写入或写后回读可能已经部分完成，使用 500 让页面先核对状态。
        throw new Error("连接参数保存或回读失败", { cause: error });
      }
    },
  );
  app.get("/internal/admin/data-sources", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    empty.parse(request.query);
    return readConfiguration(
      () => managementService.listDataSources(),
      z.object({ items: z.array(managedDataSourceSchema) }).strict(),
    );
  });
  app.get("/internal/admin/data-sources/:sourceId", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    empty.parse(request.query);
    const { sourceId } = params.parse(request.params);
    return readConfiguration(
      () => managementService.getDataSource(sourceId),
      managedDataSourceDetailSchema,
    );
  });
  app.get("/internal/admin/data-source-objects/:sourceId", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    empty.parse(request.query);
    const { sourceId } = params.parse(request.params);
    return readConfiguration(
      () => managementService.getSourceObjects(sourceId),
      managedSourceObjectsSchema,
    );
  });
  app.get("/internal/admin/data-source-secrets", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    empty.parse(request.query);
    return readConfiguration(
      () => managementService.listSecretReferences(),
      z.object({ items: z.array(managedSecretReferenceSchema) }).strict(),
    );
  });
  app.post("/internal/admin/data-source-secrets", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return reply.send(await managementService.saveSharedCredentials(request.body));
    } catch (error) {
      return sendManagementError(reply, request, error);
    }
  });

  app.post("/internal/admin/database-targets", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return reply.send(await managementService.discoverDatabaseTargets(request.body));
    } catch (error) {
      return sendManagementError(reply, request, error);
    }
  });

  app.put("/internal/admin/data-sources", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return reply.send(await managementService.saveDataSource(request.body));
    } catch (error) {
      return sendManagementError(reply, request, error);
    }
  });

  app.post("/internal/admin/data-sources/delete", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    empty.parse(request.query);
    try {
      const input = deleteDataSourceSchema.parse(request.body);
      return z
        .object({ source_id: z.literal(input.source_id) })
        .strict()
        .parse(await managementService.deleteDataSource(input));
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof ManagementConflict)
        return sendManagementError(reply, request, error);
      throw new Error("删除数据源失败，请核对实际状态", { cause: error });
    }
  });
  app.post("/internal/admin/data-source-objects/discover", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return reply.send(await managementService.discoverSourceObjects(request.body));
    } catch (error) {
      return sendManagementError(reply, request, error);
    }
  });

  app.put("/internal/admin/data-source-objects", options, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return reply.send(await managementService.replaceSourceObjects(request.body));
    } catch (error) {
      return sendManagementError(reply, request, error);
    }
  });
}

/** 管理接口不将业务数据源的驱动异常或连接信息返回给调用方。 */
function toManagementErrorMessage(_error: unknown): string {
  void _error;
  return "数据源管理请求无效或无法完成";
}

/** 配置和上游响应校验失败属于内部数据错误，请求参数已在调用前校验。 */
async function readConfiguration<T>(
  read: () => Promise<unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    return schema.parse(await read());
  } catch (cause) {
    throw new Error("读取管理配置失败", { cause });
  }
}
/** 并发冲突有独立状态码，其他写入失败继续使用既有公开说明。 */
function sendManagementError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof DatabaseConnectionError)
    return reply
      .code(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400)
      .send({ code: error.code, message: error.message, request_id: request.id });
  if (isCertificateFailure(error))
    return reply.code(503).send({
      code: "DATA_SOURCE_CERTIFICATE_INVALID",
      message: "业务 SQL Server 证书校验失败",
      request_id: request.id,
    });
  if (error instanceof ManagementConflict)
    return reply
      .code(409)
      .send({ code: "CONFLICT", message: error.message, request_id: request.id });
  return sendInvalidInput(reply, request, toManagementErrorMessage(error));
}

/** 只识别驱动错误链中的证书失败，向外只映射稳定错误码。 */
function isCertificateFailure(error: unknown, depth = 0): boolean {
  if (depth > 6 || !error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    originalError?: unknown;
  };
  return (
    (typeof value.code === "string" &&
      [
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "CERT_HAS_EXPIRED",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ].includes(value.code)) ||
    (typeof value.message === "string" &&
      /self.signed certificate|certificate (has expired|verify failed)|hostname.*certificate/i.test(
        value.message,
      )) ||
    isCertificateFailure(value.cause, depth + 1) ||
    isCertificateFailure(value.originalError, depth + 1)
  );
}

export { registerDataSourceManagementRoutes };
export type { DataSourceManagementApi };
