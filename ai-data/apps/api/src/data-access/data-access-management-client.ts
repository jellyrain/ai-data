import type { JwtService } from "../auth/jwt-service";
import { requestDataAccess } from "./request-data-access";
import { z } from "zod";
import {
  managedDataSourceSchema,
  deleteDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSourceObjectsSchema,
  managedSecretReferenceSchema,
  managedSqlServerTransportSchema,
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  deleteDatabaseConnectionSchema,
  testDatabaseConnectionSchema,
  testDatabaseConnectionDraftSchema,
  databaseTargetSchema,
} from "@ai-data/contracts";

/** GET 的签名覆盖固定路径和空请求体，读取结果严格解析公开字段。 */
const managementReads = {
  sources: {
    path: "/internal/admin/data-sources",
    schema: z.object({ items: z.array(managedDataSourceSchema) }).strict(),
  },
  source: { path: "/internal/admin/data-sources/", schema: managedDataSourceDetailSchema },
  objects: { path: "/internal/admin/data-source-objects/", schema: managedSourceObjectsSchema },
  secrets: {
    path: "/internal/admin/data-source-secrets",
    schema: z.object({ items: z.array(managedSecretReferenceSchema) }).strict(),
  },
} as const;

/** API 管理端获准调用的 DAS 操作，路径由服务端固定。 */
const managementOperations = {
  "data-source-secrets": { method: "POST", path: "/internal/admin/data-source-secrets" },
  "database-targets": { method: "POST", path: "/internal/admin/database-targets" },
  "data-sources": { method: "PUT", path: "/internal/admin/data-sources" },
  "data-sources/delete": { method: "POST", path: "/internal/admin/data-sources/delete" },
  "data-source-objects/discover": {
    method: "POST",
    path: "/internal/admin/data-source-objects/discover",
  },
  "data-source-objects": { method: "PUT", path: "/internal/admin/data-source-objects" },
} as const;

/** 将 API 已授权的管理操作签名后发送至指定注册实例。 */
class DataAccessManagementClient {
  constructor(private readonly jwt: Pick<JwtService, "signServiceRequest">) {}
  /** 连接管理沿用逐次授权、固定内部路径和签名，回读仅包含公开字段。 */
  async connection(
    serviceId: string,
    serviceUrl: string,
    operation: "list" | "get" | "create" | "update" | "remove" | "test" | "test-draft",
    id?: string,
    input?: unknown,
  ): Promise<unknown> {
    const suffix =
      operation === "test-draft"
        ? "/test"
        : operation === "list" || operation === "create"
          ? ""
          : `/${encodeURIComponent(z.string().min(1).max(128).parse(id))}${operation === "remove" ? "/delete" : operation === "test" ? "/test" : ""}`;
    const method =
      operation === "list" || operation === "get" ? "GET" : operation === "update" ? "PUT" : "POST";
    const body =
      operation === "test-draft"
        ? testDatabaseConnectionDraftSchema.parse(input)
        : operation === "create"
          ? createDatabaseConnectionSchema.parse(input)
          : operation === "update"
            ? updateDatabaseConnectionSchema.parse(input)
            : operation === "remove"
              ? deleteDatabaseConnectionSchema.parse(input)
              : operation === "test"
                ? testDatabaseConnectionSchema.parse(input)
                : undefined;
    const schema =
      operation === "list"
        ? z.object({ items: z.array(databaseConnectionSchema) }).strict()
        : operation === "remove"
          ? z.object({ secret_ref: z.string().min(1) }).strict()
          : operation === "test" || operation === "test-draft"
            ? z.object({ databases: z.array(databaseTargetSchema) }).strict()
            : databaseConnectionSchema;
    const path = `/internal/admin/database-connections${suffix}`;
    const token = await this.jwt.signServiceRequest(
      serviceId,
      "das_management",
      method,
      path,
      body,
    );
    return requestDataAccess(
      `${serviceUrl.replace(/\/$/, "")}${path}`,
      body,
      (data) => schema.parse(data),
      token,
      method,
      undefined,
      {
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: operation === "test" || operation === "test-draft" ? 120000 : 30000,
      },
    );
  }

  /** 连接选项路径由 API 构造并签名，公开结果始终按无秘密合同解析。 */
  async sqlServerTransport(
    serviceId: string,
    serviceUrl: string,
    secretRef: string,
    method: "GET" | "PUT",
    body?: unknown,
  ) {
    const path = `/internal/admin/data-source-secrets/${encodeURIComponent(secretRef)}/sqlserver-transport`;
    const token = await this.jwt.signServiceRequest(
      serviceId,
      "das_management",
      method,
      path,
      body,
    );
    return requestDataAccess(
      `${serviceUrl.replace(/\/$/, "")}${path}`,
      body,
      (data) => managedSqlServerTransportSchema.parse(data),
      token,
      method,
      undefined,
      { maxBytes: 2 * 1024 * 1024, timeoutMs: 30000 },
    );
  }

  async read(
    serviceId: string,
    serviceUrl: string,
    operation: keyof typeof managementReads,
    sourceId?: string,
  ): Promise<unknown> {
    const config = managementReads[operation];
    const path =
      config.path +
      (operation === "source" || operation === "objects"
        ? encodeURIComponent(z.string().min(1).max(128).parse(sourceId))
        : "");
    const token = await this.jwt.signServiceRequest(
      serviceId,
      "das_management",
      "GET",
      path,
      undefined,
    );
    return requestDataAccess(
      `${serviceUrl.replace(/\/$/, "")}${path}`,
      undefined,
      (data) => config.schema.parse(data),
      token,
      "GET",
      undefined,
      { maxBytes: 32 * 1024 * 1024, timeoutMs: 30000 },
    );
  }

  async execute(
    serviceId: string,
    serviceUrl: string,
    operation: keyof typeof managementOperations,
    body: unknown,
  ): Promise<unknown> {
    const { method, path } = managementOperations[operation];
    if (operation === "data-sources/delete") body = deleteDataSourceSchema.parse(body);
    const token = await this.jwt.signServiceRequest(
      serviceId,
      "das_management",
      method,
      path,
      body,
    );
    return requestDataAccess(
      `${serviceUrl.replace(/\/$/, "")}${path}`,
      body,
      (data) =>
        operation === "data-sources/delete"
          ? z
              .object({ source_id: z.literal(deleteDataSourceSchema.parse(body).source_id) })
              .strict()
              .parse(data)
          : data,
      token,
      method,
      undefined,
      { maxBytes: 32 * 1024 * 1024, timeoutMs: 30000 },
    );
  }
}

export { DataAccessManagementClient, managementOperations };
