import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** 返回符合 API 错误合同的请求校验失败。 */
function sendInvalidInput(
  reply: FastifyReply,
  request: FastifyRequest,
  message = "请求格式无效",
): FastifyReply {
  return reply.code(400).send({ code: "INVALID_INPUT", message, request_id: request.id });
}

/** 注册统一错误出口，避免向客户端泄露内部异常详情。 */
function registerContractErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return sendInvalidInput(reply, request);
    request.log.error(error);
    return reply
      .code(500)
      .send({ code: "INTERNAL_ERROR", message: "服务内部错误", request_id: request.id });
  });
}

export { registerContractErrorHandler, sendInvalidInput };
