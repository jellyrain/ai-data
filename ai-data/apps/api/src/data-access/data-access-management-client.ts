import type { JwtService } from "../auth/jwt-service";
import { requestDataAccess } from "./request-data-access";

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
