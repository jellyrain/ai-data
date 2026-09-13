import { queryResultSchema, type QueryResult } from "@ai-data/contracts";

/** 连接器出口与跨服务查询结果复用同一组列、行、值和行数约束。 */
const connectorExecutionResultSchema = queryResultSchema;

/** 连接器完成执行后的已校验统一表格结果类型。 */
type ConnectorExecutionResult = QueryResult;

export { connectorExecutionResultSchema };
export type { ConnectorExecutionResult };
