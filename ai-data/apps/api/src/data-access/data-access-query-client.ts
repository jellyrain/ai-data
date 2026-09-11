import axios from "axios";
import { queryResultSchema, type QueryResult } from "@ai-data/contracts";

import type { DataAccessServiceRegistry } from "./data-access-types";
import type { AuthorizedQuery } from "../query/query-authorization-service";

/** API 调用已登记 DAS 的查询客户端。 */
class DataAccessQueryClient {
  constructor(private readonly registry: DataAccessServiceRegistry) {}

  /** 选择健康实例执行内部查询并校验标准化结果。 */
  async execute(input: AuthorizedQuery): Promise<QueryResult> {
    const services = await this.registry.listHealthyServices();
    const service = services.find((item) =>
      item.sources.some(
        (source) =>
          source.source_id === input.request.query.source_id && source.status === "healthy",
      ),
    );
    if (!service) throw new Error("没有可用的 DAS 数据源");
    const response = await axios.post(`${service.serviceUrl}/internal/query`, input.request, {
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(`DAS 查询失败: HTTP ${response.status}`);
    return queryResultSchema.parse(response.data);
  }
}

export { DataAccessQueryClient };
