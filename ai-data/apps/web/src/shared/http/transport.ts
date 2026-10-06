import { contractErrorSchema } from "@ai-data/contracts";
import { ApiError } from "./api-error";
import type { Transport } from "./http-types";

/** JSON HTTP 边界；限定同源 API 路径，避免意外外发令牌。 */
function createTransport(fetcher: typeof fetch = fetch): Transport {
  return async (path, options = {}) => {
    if (!/^\/(?:auth|api)\//.test(path) || path.includes("\\"))
      throw new ApiError("请求路径无效", 0, "INVALID_PATH");
    const timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150_000)
      throw new ApiError("请求等待时间无效", 0, "INVALID_TIMEOUT");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetcher(path, {
        method: options.method ?? "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      if (options.signal?.aborted) throw new ApiError("请求已取消", 0, "CANCELLED");
      throw new ApiError(timeout.aborted ? "请求超时，请重试" : "无法连接服务，请检查网络后重试");
    }
    if (response.status === 204) return undefined;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = contractErrorSchema.safeParse(body);
      throw new ApiError(
        error.success ? error.data.message : "服务暂时不可用，请稍后重试",
        response.status,
        error.success ? error.data.code : "HTTP_ERROR",
        error.success ? error.data.request_id : undefined,
      );
    }
    if (body === null) throw new ApiError("服务响应格式异常", response.status, "INVALID_RESPONSE");
    return body;
  };
}

export { createTransport };
