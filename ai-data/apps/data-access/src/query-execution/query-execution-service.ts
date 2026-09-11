import type { ConnectorExecutionResult } from "../connectors/connector-result";
import type { DataSourceConnector } from "../connectors/connector";
import { applyOutputMasks } from "./result-masker";
import type { QueryPlanner } from "../query-planning/query-planner";

/** 查询执行阶段按 source_id 获取已缓存业务连接器的能力。 */
interface QueryConnectorLookup {
  get(sourceId: string): Promise<DataSourceConnector>;
}

/** 串联已验签规划、连接器执行和结果出口脱敏。 */
class QueryExecutionService {
  constructor(
    private readonly planner: QueryPlanner,
    private readonly connectorLookup: QueryConnectorLookup,
  ) {}

  /** 执行 API 已签名请求，只返回经过脱敏的统一结果。 */
  async execute(input: unknown): Promise<ConnectorExecutionResult> {
    const planned = await this.planner.plan(input);
    const connector = await this.connectorLookup.get(planned.query.source_id);
    const result = await connector.execute(planned.query);
    return applyOutputMasks(result, planned.access);
  }
}

export { QueryExecutionService };
export type { QueryConnectorLookup };
