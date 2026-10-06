/** 面向界面的请求失败，保留 HTTP 状态和服务端请求标识。 */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "NETWORK_ERROR",
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export { ApiError };
