/** 查询调用方发出的取消信号，连接器负责传播到当前请求。 */
interface ConnectorExecutionOptions {
  signal?: AbortSignal;
}

/** 排队和执行使用的总时间预算，单位毫秒。 */
interface QueryExecutionOptions extends ConnectorExecutionOptions {
  timeoutMs?: number;
}

/** 资源闸门交给执行任务的信号与剩余时间。 */
interface ActiveQueryOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** 单个数据源的执行容量；等待容量与并发容量相同。 */
interface QueryResourceConfig {
  concurrencyLimit: number;
  timeoutMs: number;
}

/** 可向公共查询错误合同映射的资源失败分类。 */
type QueryResourceErrorCode =
  "QUERY_TIMEOUT" | "CANCELLED" | "QUERY_LIMIT_EXCEEDED" | "DATA_SOURCE_UNAVAILABLE";

export type {
  ActiveQueryOptions,
  ConnectorExecutionOptions,
  QueryExecutionOptions,
  QueryResourceConfig,
  QueryResourceErrorCode,
};
