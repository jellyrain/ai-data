import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** 用统一 contracts 错误格式返回单个路由输入错误。 */
function sendInvalidInput(
  reply: FastifyReply,
  request: FastifyRequest,
  message: string,
): FastifyReply {
  return reply.code(400).send({ code: "INVALID_INPUT", message, request_id: request.id });
}

/** 注册未被业务路由转换的 Fastify 运行时错误出口。 */
function registerContractErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return sendInvalidInput(reply, request, "请求格式无效");
    }
    request.log.error(error);
    return reply
      .code(500)
      .send({ code: "INTERNAL_ERROR", message: "服务内部错误", request_id: request.id });
  });
}

export { registerContractErrorHandler, sendInvalidInput };
