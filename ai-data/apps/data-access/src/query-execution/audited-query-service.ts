import type { InternalQueryVerifier } from "../auth/internal-query-verifier";
import {
  dataAccessQueryRequestSchema,
  type DataAccessQueryRequest,
  type ContractErrorCode,
} from "@ai-data/contracts";
import type { QueryExecutionService } from "./query-execution-service";
import type { QueryAuditEntry } from "./query-audit-types";
import type { ConnectorExecutionResult } from "../connectors/connector-result";
import { QueryPlanningError } from "../query-planning/query-planner";
import { QueryRequestError } from "./query-request-error";

/** 请求处理链使用的持久化审计写入能力。 */
interface QueryAuditWriter {
  /** 写入最终处理事件，失败时不得把业务结果交付给调用方。 */
  write(entry: QueryAuditEntry): Promise<unknown>;
}

/** 单次 HTTP 查询的服务器标识和断开信号，均由路由提供。 */
type QueryRequestContext = { correlationId: string; signal?: AbortSignal };

/** 认证、执行和审计的请求边界。 */
class AuditedQueryService {
  constructor(
    private readonly execution: Pick<QueryExecutionService, "execute">,
    private readonly verifier: Pick<InternalQueryVerifier, "verify">,
    private readonly audit: QueryAuditWriter,
  ) {}
  /** 验签后建立可信审计上下文；每条请求只写一次最终事件。 */
  async execute(
    input: unknown,
    token: string,
    context: QueryRequestContext,
  ): Promise<ConnectorExecutionResult> {
    const start = performance.now();
    let trusted: DataAccessQueryRequest | undefined;
    let result: ConnectorExecutionResult | undefined;
    let failure: QueryRequestError | undefined;
    try {
      const parsed = dataAccessQueryRequestSchema.safeParse(input);
      if (!parsed.success || !token)
        throw new QueryRequestError("INVALID_INPUT", "查询请求格式无效", 400);
      try {
        await this.verifier.verify(parsed.data, token);
      } catch {
        throw new QueryRequestError("UNAUTHORIZED", "查询请求未通过验证", 403);
      }
      trusted = parsed.data;
      assertRequestActive(context.signal);
      result = await this.execution.execute(trusted, { signal: context.signal });
      assertRequestActive(context.signal);
    } catch (error) {
      failure = context.signal?.aborted
        ? new QueryRequestError("CANCELLED", "数据查询已取消", 499)
        : classifyQueryFailure(error);
    }
    const outcome: QueryAuditEntry["outcome"] =
      failure === undefined
        ? "executed"
        : failure.code === "QUERY_TIMEOUT"
          ? "timed_out"
          : ["INVALID_INPUT", "UNAUTHORIZED", "UNSUPPORTED_QUERY", "QUERY_LIMIT_EXCEEDED"].includes(
                failure.code,
              )
            ? "rejected"
            : "failed";
    await this.write({
      correlationId: context.correlationId,
      ...trustedSummary(trusted),
      outcome,
      durationMs: Math.max(0, Math.round(performance.now() - start)),
      ...(failure
        ? {
            errorCode: failure.code,
            ...(outcome === "rejected" ? { rejectionReason: failure.message } : {}),
          }
        : { rowCount: result!.row_count }),
    });
    if (failure) throw failure;
    assertRequestActive(context.signal);
    return result!;
  }

  /** JSON 解析等早于验签的拒绝只记录服务器生成的标识。 */
  async rejectUnverified(correlationId: string): Promise<void> {
    await this.write({
      correlationId,
      objectIds: [],
      querySummary: {},
      parametersSummary: {},
      rowFilterInjected: false,
      outcome: "rejected",
      errorCode: "INVALID_INPUT",
      rejectionReason: "查询请求格式无效",
    });
  }

  private async write(entry: QueryAuditEntry): Promise<void> {
    try {
      await this.audit.write(entry);
    } catch {
      throw new QueryRequestError("INTERNAL_ERROR", "查询审计暂不可用", 503);
    }
  }
}

/** 结构摘要保留定位所需的逻辑对象和参数名，值、签名及返回数据留在执行链内。 */
function trustedSummary(
  request?: DataAccessQueryRequest,
): Pick<QueryAuditEntry, "objectIds" | "querySummary" | "parametersSummary" | "rowFilterInjected"> &
  Partial<QueryAuditEntry> {
  if (!request)
    return { objectIds: [], querySummary: {}, parametersSummary: {}, rowFilterInjected: false };
  const query = request.query;
  const relational = query.type === "relational_query";
  return {
    userId: request.access.user_id,
    organizationId: request.access.organization_id,
    analysisRunId: request.access.analysis_run_id,
    policyVersion: request.access.policy_version,
    sourceId: query.source_id,
    objectIds: [
      ...new Set([
        query.from.object_id,
        ...(relational ? query.joins.map((join) => join.object_id) : []),
      ]),
    ],
    querySummary: {
      type: query.type,
      ...(relational ? { select_count: query.select.length, join_count: query.joins.length } : {}),
    },
    parametersSummary: relational
      ? {}
      : {
          names: query.parameters.map((parameter) => parameter.name),
          count: query.parameters.length,
        },
    rowFilterInjected:
      relational &&
      (query.filters.items.length > 0 ||
        query.from.filters !== undefined ||
        query.joins.some((join) => join.filters !== undefined)),
  };
}

/** 将底层错误映射成固定说明，审计与公开响应均不回显驱动错误文本。 */
function classifyQueryFailure(error: unknown): QueryRequestError {
  if (error instanceof QueryRequestError) return error;
  if (error instanceof QueryPlanningError)
    return new QueryRequestError("UNSUPPORTED_QUERY", "查询无法映射为本地允许的操作", 400);
  const errors: Partial<Record<ContractErrorCode, [string, number]>> = {
    QUERY_TIMEOUT: ["数据查询超时", 504],
    CANCELLED: ["数据查询已取消", 499],
    QUERY_LIMIT_EXCEEDED: ["查询超出资源上限", 429],
    DATA_SOURCE_UNAVAILABLE: ["数据源暂时不可用", 503],
  };
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && Object.hasOwn(errors, code)) {
    const [message, status] = errors[code as ContractErrorCode]!;
    return new QueryRequestError(code as ContractErrorCode, message, status);
  }
  return new QueryRequestError("INTERNAL_ERROR", "查询执行失败", 500);
}

/** 请求断开后拒绝开始执行和交付晚到结果。 */
function assertRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new QueryRequestError("CANCELLED", "数据查询已取消", 499);
}

export { AuditedQueryService };
export type { QueryAuditWriter, QueryRequestContext };
