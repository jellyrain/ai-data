import type { QueryResourceErrorCode } from "./query-execution-types";

/** 数据源资源拒绝和中断的稳定错误，供查询边界与审计统一分类。 */
class QueryResourceError extends Error {
  constructor(
    readonly code: QueryResourceErrorCode,
    options?: ErrorOptions,
  ) {
    const messages: Record<QueryResourceErrorCode, string> = {
      QUERY_TIMEOUT: "查询超时",
      CANCELLED: "查询已取消",
      QUERY_LIMIT_EXCEEDED: "数据源查询等待队列已满",
      DATA_SOURCE_UNAVAILABLE: "数据源已关闭",
    };
    super(messages[code], options);
    this.name = "QueryResourceError";
  }
}

/** 保留内部超时和关闭原因，外部取消统一转为合同错误。 */
function queryAbortError(signal: AbortSignal): QueryResourceError {
  return signal.reason instanceof QueryResourceError
    ? signal.reason
    : new QueryResourceError("CANCELLED", { cause: signal.reason });
}

export { QueryResourceError, queryAbortError };
