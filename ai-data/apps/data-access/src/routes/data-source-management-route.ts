import type { FastifyInstance } from "fastify";
import { sendInvalidInput } from "./contract-error";

/** 数据源管理路由需要的最小服务能力。 */
interface DataSourceManagementApi {
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
  /** 发现一个 source_id 的完整对象目录。 */
  discoverSourceObjects(input: unknown): Promise<unknown>;
  /** 替换一个 source_id 的 API 对象白名单。 */
  replaceSourceObjects(input: unknown): Promise<{ source_id: string; object_count: number }>;
}

/** 注册供 API 管理端调用的数据源配置、发现和对象白名单接口。 */
function registerDataSourceManagementRoutes(
  app: FastifyInstance,
  managementService: DataSourceManagementApi,
): void {
  app.post("/internal/admin/data-source-secrets", async (request, reply) => {
    try {
      return reply.send(await managementService.saveSharedCredentials(request.body));
    } catch (error) {
      return sendInvalidInput(reply, request, toManagementErrorMessage(error));
    }
  });

  app.post("/internal/admin/database-targets", async (request, reply) => {
    try {
      return reply.send(await managementService.discoverDatabaseTargets(request.body));
    } catch (error) {
      return sendInvalidInput(reply, request, toManagementErrorMessage(error));
    }
  });

  app.put("/internal/admin/data-sources", async (request, reply) => {
    try {
      return reply.send(await managementService.saveDataSource(request.body));
    } catch (error) {
      return sendInvalidInput(reply, request, toManagementErrorMessage(error));
    }
  });

  app.post("/internal/admin/data-source-objects/discover", async (request, reply) => {
    try {
      return reply.send(await managementService.discoverSourceObjects(request.body));
    } catch (error) {
      return sendInvalidInput(reply, request, toManagementErrorMessage(error));
    }
  });

  app.put("/internal/admin/data-source-objects", async (request, reply) => {
    try {
      return reply.send(await managementService.replaceSourceObjects(request.body));
    } catch (error) {
      return sendInvalidInput(reply, request, toManagementErrorMessage(error));
    }
  });
}

/** 管理接口不将业务数据源的驱动异常或连接信息返回给调用方。 */
function toManagementErrorMessage(_error: unknown): string {
  void _error;
  return "数据源管理请求无效或无法完成";
}

export { registerDataSourceManagementRoutes };
export type { DataSourceManagementApi };
