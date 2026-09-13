import type { FastifyReply, FastifyRequest } from "fastify";
import type { InternalServiceVerifier } from "../auth/internal-service-verifier";

/** 在业务处理前校验内部服务调用；缺少认证设施时保持拒绝。 */
function internalServiceAuth(
  purpose: "das_catalog" | "das_management",
  verifier?: Pick<InternalServiceVerifier, "verify">,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || !authorization.slice(7).trim()) {
      reply.code(401).send({
        code: "AUTHENTICATION_FAILED",
        message: "缺少内部服务凭据",
        request_id: request.id,
      });
      return;
    }
    try {
      if (!verifier) throw new Error("内部服务验签器未配置");
      await verifier.verify(
        authorization.slice(7),
        purpose,
        request.method,
        request.url,
        request.body,
      );
    } catch {
      reply.code(403).send({
        code: "AUTHENTICATION_FAILED",
        message: "内部服务请求未通过验证",
        request_id: request.id,
      });
    }
  };
}

export { internalServiceAuth };
