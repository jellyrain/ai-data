import type { ConnectorExecutionResult } from "../connectors/connector-result";
import type { DataSourceConnector } from "../connectors/connector";
import { applyOutputMasks } from "./result-masker";
import type { QueryPlanner } from "../query-planning/query-planner";
import { assertResultBudget } from "../connectors/result-budget";

/** 查询执行阶段按 source_id 获取已缓存业务连接器的能力。 */
interface QueryConnectorLookup {
  /** 取得执行计划所选数据源的连接器。 */
  get(sourceId: string): Promise<DataSourceConnector>;
}

/** 串联本地查询规划、连接器执行和结果出口处理；请求认证由调用链负责。 */
class QueryExecutionService {
  constructor(
    private readonly planner: QueryPlanner,
    private readonly connectorLookup: QueryConnectorLookup,
  ) {}

  /** 执行通过规划的请求，并按结果列规则处理返回值。 */
  async execute(
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectorExecutionResult> {
    options?.signal?.throwIfAborted();
    const planned = await this.planner.plan(input);
    options?.signal?.throwIfAborted();
    const connector = await this.connectorLookup.get(planned.query.source_id);
    options?.signal?.throwIfAborted();
    const result = await connector.execute(planned.query, options);
    options?.signal?.throwIfAborted();
    const masked = applyOutputMasks(result, planned.access);
    assertResultBudget(masked);
    return {
      ...masked,
      delivery: masked.truncated
        ? { status: "truncated", total_row_count: null }
        : { status: "complete", total_row_count: masked.row_count },
    };
  }
}

export { QueryExecutionService };
export type { QueryConnectorLookup };
