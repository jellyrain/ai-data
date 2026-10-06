import type { ContractError, ContractErrorCode } from "@ai-data/contracts";
import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ApplicationError } from "../errors/application-error";

/** HTTP 状态只在传输边界决定；穷尽合同错误码，新增错误码时由类型检查提醒补充。 */
const errorStatus = {
  INVALID_INPUT: 400,
  AUTHENTICATION_FAILED: 401,
  UNAUTHORIZED: 403,
  UNAUTHORIZED_OBJECT: 403,
  UNAUTHORIZED_COLUMN: 403,
  POLICY_REJECTED: 403,
  UNSUPPORTED_QUERY: 400,
  QUERY_LIMIT_EXCEEDED: 400,
  QUERY_TIMEOUT: 504,
  DATA_SOURCE_UNAVAILABLE: 503,
  DATA_SOURCE_CERTIFICATE_INVALID: 503,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  CANCELLED: 409,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
} satisfies Record<ContractErrorCode, number>;

/** 所有 API 合同错误都携带当前请求 ID；内部错误的详细原因只进入日志。 */
function sendContractError(
  reply: FastifyReply,
  request: FastifyRequest,
  code: ContractErrorCode,
  message: string,
): FastifyReply {
  const body: ContractError = {
    code,
    message: code === "INTERNAL_ERROR" ? "服务内部错误" : message,
    request_id: request.id,
  };
  return reply.code(errorStatus[code]).send(body);
}

/** 返回请求输入不符合合同的错误。 */
function sendInvalidInput(
  reply: FastifyReply,
  request: FastifyRequest,
  message = "请求格式无效",
): FastifyReply {
  return sendContractError(reply, request, "INVALID_INPUT", message);
}

/** 在单一 HTTP 边界区分业务失败、请求解析错误和内部故障。 */
function registerContractErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    sendContractError(reply, request, "NOT_FOUND", "请求资源不存在"),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      if (errorStatus[error.code] >= 500)
        request.log.error({ err: error, request_id: request.id }, "API 请求失败");
      return sendContractError(reply, request, error.code, error.message);
    }
    // 数据库和 DAS 的校验错误已在适配器转换；这里的 ZodError 对应路由请求输入。
    if (
      error instanceof ZodError ||
      error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
      error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE ||
      error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE
    )
      return sendInvalidInput(reply, request);
    request.log.error({ err: error, request_id: request.id }, "API 请求失败");
    return sendContractError(reply, request, "INTERNAL_ERROR", "服务内部错误");
  });
}

export { registerContractErrorHandler, sendInvalidInput };
