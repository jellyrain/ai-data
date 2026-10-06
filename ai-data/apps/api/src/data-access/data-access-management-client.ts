import type { JwtService } from "../auth/jwt-service";
import { requestDataAccess } from "./request-data-access";
import { z } from "zod";
import {
  managedDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSourceObjectsSchema,
  managedSecretReferenceSchema,
  managedSqlServerTransportSchema,
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
  "data-source-objects/discover": {
    method: "POST",
    path: "/internal/admin/data-source-objects/discover",
  },
  "data-source-objects": { method: "PUT", path: "/internal/admin/data-source-objects" },
} as const;

/** 将 API 已授权的管理操作签名后发送至指定注册实例。 */
class DataAccessManagementClient {
  constructor(private readonly jwt: Pick<JwtService, "signServiceRequest">) {}

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
      (data) => data,
      token,
      method,
    );
  }
}

export { DataAccessManagementClient, managementOperations };
