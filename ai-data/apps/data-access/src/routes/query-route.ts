import type { FastifyInstance, FastifyRequest } from "fastify";
import type { QueryExecutionService } from "../query-execution/query-execution-service";
import type { InternalQueryVerifier } from "../auth/internal-query-verifier";
import {
  AuditedQueryService,
  type QueryAuditWriter,
} from "../query-execution/audited-query-service";
import { QueryRequestError } from "../query-execution/query-request-error";

/** 注册 API 调用 DAS 的内部查询接口。 */
function registerQueryRoute(
  app: FastifyInstance,
  execution: QueryExecutionService,
  verifier: InternalQueryVerifier,
  audit: QueryAuditWriter,
): void {
  const service = new AuditedQueryService(execution, verifier, audit);
  // 单独封装查询路由，使 JSON 解析阶段的失败也进入同一审计边界。
  void app.register(async (scope) => {
    const processed = new WeakSet<FastifyRequest>();
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("x-request-id", request.id);
    });
    scope.setErrorHandler(async (error, request, reply) => {
      let failure =
        error instanceof QueryRequestError
          ? error
          : processed.has(request)
            ? new QueryRequestError("INTERNAL_ERROR", "查询执行失败", 500)
            : new QueryRequestError("INVALID_INPUT", "查询请求格式无效", 400);
      if (!processed.has(request)) {
        try {
          await service.rejectUnverified(request.id);
        } catch {
          failure = new QueryRequestError("INTERNAL_ERROR", "查询审计暂不可用", 503);
        }
      }
      if (failure.statusCode >= 500)
        request.log.error({ code: failure.code, request_id: request.id }, failure.message);
      return reply
        .code(failure.statusCode)
        .send({ code: failure.code, message: failure.message, request_id: request.id });
    });
    scope.post("/internal/query", async (request, reply) => {
      processed.add(request);
      const controller = new AbortController();
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", disconnect);
      reply.raw.once("close", disconnect);
      const token = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7)
        : "";
      try {
        return reply.send(
          await service.execute(request.body, token, {
            correlationId: request.id,
            signal: controller.signal,
          }),
        );
      } finally {
        request.raw.removeListener("aborted", disconnect);
        reply.raw.removeListener("close", disconnect);
      }
    });
  });
}

export { registerQueryRoute };
