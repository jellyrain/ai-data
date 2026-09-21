import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { ReportExecutionService } from "../reports/report-execution-service";
import type { ReportRevisionService } from "../reports/report-revision-service";
import { bearerToken } from "./auth-routes";
const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const narrativeInput = z
  .object({
    prompt: z.string().min(1).max(32000),
    idempotency_key: z.string().min(1).max(128),
    agent_id: z.string().min(1).max(128).optional(),
  })
  .strict();
/** 保存执行和对话修改使用独立入口，读取及导出不会触发业务查询。 */
function registerReportExecutionRoutes(
  app: FastifyInstance,
  auth: ApiAuthService,
  services: {
    executions: Pick<ReportExecutionService, "execute" | "get" | "exportContent">;
    revisions: Pick<ReportRevisionService, "revise" | "narrate" | "narratives">;
  },
) {
  app.post("/reports/:id/execute", async (request) =>
    services.executions.execute(
      await auth.refreshContext(await auth.loadContext(bearerToken(request))),
      paramsSchema.parse(request.params).id,
      request.body,
    ),
  );
  app.get("/report-executions/:id", async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .send(
        await services.executions.get(
          await auth.loadContext(bearerToken(request)),
          paramsSchema.parse(request.params).id,
        ),
      ),
  );
  app.get("/report-executions/:id/export-content", async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .send(
        await services.executions.exportContent(
          await auth.loadContext(bearerToken(request)),
          paramsSchema.parse(request.params).id,
        ),
      ),
  );
  app.post("/reports/:id/revisions", async (request, reply) =>
    reply
      .code(202)
      .send(
        await services.revisions.revise(
          await auth.refreshContext(await auth.loadContext(bearerToken(request))),
          paramsSchema.parse(request.params).id,
          request.body,
        ),
      ),
  );
  app.post("/report-executions/:id/narratives", async (request, reply) =>
    reply
      .code(202)
      .send(
        await services.revisions.narrate(
          await auth.refreshContext(await auth.loadContext(bearerToken(request))),
          paramsSchema.parse(request.params).id,
          narrativeInput.parse(request.body),
        ),
      ),
  );
  app.get("/report-executions/:id/narratives", async (request, reply) =>
    reply.header("cache-control", "no-store").send({
      items: await services.revisions.narratives(
        await auth.loadContext(bearerToken(request)),
        paramsSchema.parse(request.params).id,
      ),
    }),
  );
}
export { registerReportExecutionRoutes };
