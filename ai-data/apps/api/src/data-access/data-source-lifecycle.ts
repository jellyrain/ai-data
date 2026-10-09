import type { DataAccessManagementClient } from "./data-access-management-client";
import type { DataAccessSessionService } from "./data-access-session-service";
import {
  dataSourceManagementConfigSchema,
  deleteDataSourceSchema,
  managedDataSourceDetailSchema,
} from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";

/** 数据源创建与删除共享源级锁；清理回调只删除 API 当前配置。 */
type LifecycleDependencies = {
  client: Pick<DataAccessManagementClient, "read" | "execute">;
  registry: Pick<DataAccessSessionService, "listRegisteredServices">;
  store: {
    run<T>(sourceId: string, operation: (clear: () => Promise<void>) => Promise<T>): Promise<T>;
  };
};
/** 协调 DAS 数据源生命周期与 API 当前业务配置。 */
class DataSourceLifecycle {
  constructor(private readonly dependencies: LifecycleDependencies) {}
  async execute(
    serviceId: string,
    serviceUrl: string,
    operation: "data-sources" | "data-sources/delete",
    body: unknown,
  ): Promise<unknown> {
    const input =
      operation === "data-sources/delete"
        ? deleteDataSourceSchema.parse(body)
        : dataSourceManagementConfigSchema.parse(body);
    const { client, registry, store } = this.dependencies;
    return store.run(input.source_id, async (clear) => {
      if (operation === "data-sources")
        return client.execute(serviceId, serviceUrl, operation, input);
      // API 目录按 source_id 共用；包含失联实例，避免误删其他 DAS 仍引用的权限。
      const services = await registry.listRegisteredServices();
      if (
        services.some(
          (service) =>
            service.serviceId !== serviceId &&
            service.sources.some((source) => source.source_id === input.source_id),
        )
      )
        throw new ApplicationError(
          "CONFLICT",
          "其他 DAS 实例仍登记了同名数据源，请先核对数据源归属",
        );
      const current = await this.read(serviceId, serviceUrl, input.source_id);
      if (current.config) {
        try {
          await client.execute(serviceId, serviceUrl, operation, input);
        } catch (error) {
          // 只有可能丢失回执的错误才通过回读恢复；权限和输入错误直接返回。
          if (
            !(error instanceof ApplicationError) ||
            !["CONFLICT", "DATA_SOURCE_UNAVAILABLE", "QUERY_TIMEOUT", "INTERNAL_ERROR"].includes(
              error.code,
            )
          )
            throw error;
          if ((await this.read(serviceId, serviceUrl, input.source_id)).config) throw error;
        }
        if ((await this.read(serviceId, serviceUrl, input.source_id)).config)
          throw new ApplicationError("CONFLICT", "数据源仍存在，未清理 API 配置，请重新读取后操作");
      }
      // 重试时 DAS 可以已经删除；API 本地事务失败会回滚，可再次清理相同 source_id。
      await clear();
      return { source_id: input.source_id };
    });
  }
  private async read(serviceId: string, serviceUrl: string, sourceId: string) {
    const parsed = managedDataSourceDetailSchema.safeParse(
      await this.dependencies.client.read(serviceId, serviceUrl, "source", sourceId),
    );
    if (!parsed.success)
      throw new ApplicationError("INTERNAL_ERROR", "DAS 响应格式无效", { cause: parsed.error });
    const value = parsed.data;
    if (value.config && value.config.source_id !== sourceId)
      throw new ApplicationError("INTERNAL_ERROR", "DAS 返回的数据源标识不匹配");
    return value;
  }
}
export { DataSourceLifecycle };
