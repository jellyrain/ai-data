import axios from "axios";
import { contractErrorSchema, type ContractErrorCode } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";

/** DAS 的提示可能包含连接细节；API 按合同错误码生成面向调用方的说明。 */
const messages: Record<ContractErrorCode, string> = {
  INVALID_INPUT: "数据查询参数无效",
  AUTHENTICATION_FAILED: "内部服务认证失败",
  UNAUTHORIZED: "没有数据访问权限",
  UNAUTHORIZED_OBJECT: "无权访问查询对象",
  UNAUTHORIZED_COLUMN: "无权访问查询字段",
  POLICY_REJECTED: "查询被权限策略拒绝",
  UNSUPPORTED_QUERY: "数据源不支持此查询",
  QUERY_LIMIT_EXCEEDED: "查询超出资源上限",
  QUERY_TIMEOUT: "数据查询超时",
  DATA_SOURCE_UNAVAILABLE: "数据源暂时不可用",
  RATE_LIMITED: "数据访问请求过于频繁",
  NOT_FOUND: "数据资源不存在",
  CANCELLED: "数据查询已取消",
  CONFLICT: "请求状态发生冲突",
  INTERNAL_ERROR: "数据访问服务内部错误",
};

/** 将远端 HTTP 失败归入 API 合同；内部服务身份失败属于服务故障。 */
function responseError(status: number, body: unknown): ApplicationError {
  const parsed = contractErrorSchema.safeParse(body);
  // 代理等中间层可能返回非合同错误体，只对已知传输状态提供后备分类。
  const fallbackCodes: Partial<Record<number, ContractErrorCode>> = {
    502: "DATA_SOURCE_UNAVAILABLE",
    503: "DATA_SOURCE_UNAVAILABLE",
    504: "QUERY_TIMEOUT",
    429: "RATE_LIMITED",
  };
  let code = parsed.success ? parsed.data.code : (fallbackCodes[status] ?? "INTERNAL_ERROR");
  if (code === "AUTHENTICATION_FAILED") code = "INTERNAL_ERROR";
  return new ApplicationError(code, messages[code], {
    cause: new Error(`DAS 返回 HTTP ${status}`, { cause: body }),
  });
}

/** 统一 DAS 传输和响应校验边界；parse 只校验远端数据，校验失败属于内部故障。 */
async function requestDataAccess<T>(
  url: string,
  body: unknown,
  parse: (data: unknown) => T,
  token?: string,
  method: "POST" | "PUT" = "POST",
  signal?: AbortSignal,
  responseBudget?: { maxBytes: number; timeoutMs: number },
): Promise<T> {
  if (signal?.aborted) throw new ApplicationError("CANCELLED", messages.CANCELLED);
  const response = await (method === "PUT" ? axios.put : axios.post)<unknown>(url, body, {
    ...(signal ? { signal } : {}),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    validateStatus: () => true,
    maxRedirects: 0,
    ...(responseBudget
      ? { maxContentLength: responseBudget.maxBytes, timeout: responseBudget.timeoutMs }
      : {}),
  }).catch((cause: unknown) => {
    if (!axios.isAxiosError(cause)) throw cause;
    // 管理请求可能携带连接凭据；保留错误码与堆栈，移除可被日志序列化的传输对象。
    delete cause.config;
    delete cause.request;
    delete cause.response;
    if (
      responseBudget &&
      cause.code === "ERR_BAD_RESPONSE" &&
      cause.message.includes("maxContentLength")
    )
      throw new ApplicationError("QUERY_LIMIT_EXCEEDED", messages.QUERY_LIMIT_EXCEEDED, { cause });
    if (cause.code === "ERR_CANCELED")
      throw new ApplicationError("CANCELLED", messages.CANCELLED, { cause });
    const isTimeout = cause.code === "ECONNABORTED" || cause.code === "ETIMEDOUT";
    const isConnectionFailure = [
      "ERR_NETWORK",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(cause.code ?? "");
    if (!isTimeout && !isConnectionFailure) throw cause;
    const code = isTimeout ? "QUERY_TIMEOUT" : "DATA_SOURCE_UNAVAILABLE";
    throw new ApplicationError(code, messages[code], { cause });
  });
  if (signal?.aborted) throw new ApplicationError("CANCELLED", messages.CANCELLED);
  if (response.status < 200 || response.status >= 300)
    throw responseError(response.status, response.data);
  try {
    return parse(response.data);
  } catch (cause) {
    throw new ApplicationError("INTERNAL_ERROR", "DAS 响应格式无效", { cause });
  }
}

export { requestDataAccess };
