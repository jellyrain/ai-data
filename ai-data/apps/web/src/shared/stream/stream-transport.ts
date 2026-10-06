import { contractErrorSchema } from "@ai-data/contracts";
import { ApiError } from "../http/api-error";

/** 仅打开同源运行事件端点，消费周期的超时和身份清理由订阅方管理。 */
async function openEventStream(
  path: string,
  token: string,
  cursor: number,
  signal: AbortSignal,
): Promise<Response> {
  if (!/^\/api\/analysis-runs\/[^/\\?#]+\/events$/.test(path))
    throw new ApiError("事件路径无效", 0, "INVALID_PATH");
  const response = await fetch(path, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Last-Event-ID": String(cursor),
    },
  });
  if (!response.ok) {
    const body = contractErrorSchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      body.success ? body.data.message : "事件连接失败",
      response.status,
      body.success ? body.data.code : "HTTP_ERROR",
      body.success ? body.data.request_id : undefined,
    );
  }
  return response;
}
export { openEventStream };
