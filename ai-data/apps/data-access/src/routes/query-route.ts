import type { FastifyInstance } from "fastify";
import { dataAccessQueryRequestSchema } from "@ai-data/contracts";
import type { QueryExecutionService } from "../query-execution/query-execution-service";
import type { InternalQueryVerifier } from "../auth/internal-query-verifier";
import { sendInvalidInput } from "./contract-error";

/** 注册 API 调用 DAS 的内部查询接口。 */
function registerQueryRoute(
  app: FastifyInstance,
  execution: QueryExecutionService,
  verifier: InternalQueryVerifier,
): void {
  app.post("/internal/query", async (request, reply) => {
    const parsed = dataAccessQueryRequestSchema.safeParse(request.body);
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "";
    if (!parsed.success || !token) return sendInvalidInput(reply, request, "查询请求格式无效");
    try {
      await verifier.verify(parsed.data, token);
    } catch (error) {
      request.log.warn(error);
      return reply
        .code(403)
        .send({ code: "UNAUTHORIZED", message: "查询请求未通过验证", request_id: request.id });
    }
    return reply.send(await execution.execute(parsed.data));
  });
}

export { registerQueryRoute };
