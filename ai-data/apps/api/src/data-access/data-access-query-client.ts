import { queryResultSchema, type QueryResult } from "@ai-data/contracts";
import type { DataAccessServiceRegistry } from "./data-access-types";
import type { AuthorizedQuery } from "../query/query-authorization-service";
import { ApplicationError } from "../errors/application-error";
import { requestDataAccess } from "./request-data-access";

/** API 调用已登记 DAS 的查询客户端，消费授权服务生成的签名和内部令牌。 */
class DataAccessQueryClient {
  constructor(private readonly registry: Pick<DataAccessServiceRegistry, "listHealthyServices">) {}

  /** 选择同时报告目标数据源健康的实例，执行查询并校验标准化结果。 */
  async execute(input: AuthorizedQuery, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    if (options?.signal?.aborted) throw new ApplicationError("CANCELLED", "数据查询已取消");
    const services = await this.registry.listHealthyServices();
    const service = services.find((item) =>
      item.sources.some(
        (source) =>
          source.source_id === input.request.query.source_id && source.status === "healthy",
      ),
    );
    if (!service) throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "没有可用的 DAS 数据源");
    return requestDataAccess(
      `${service.serviceUrl}/internal/query`,
      input.request,
      (data) => queryResultSchema.parse(data),
      input.token,
      "POST",
      options?.signal,
    );
  }
}

export { DataAccessQueryClient };
