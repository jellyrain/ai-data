import { z } from "zod";
import { saveReportInputSchema } from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiAnalysisServices, ApiAuthService } from "../app-types";
import { bearerToken } from "./auth-routes";
import type { KnowledgeService } from "../knowledge/knowledge-service";

const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const versionSchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict();
const updateReportSchema = z
  .object({ expected_version: z.number().int().positive(), report: saveReportInputSchema })
  .strict();

/** 指标发布、执行与版本化报告使用当前组织和身份。 */
function registerMetricReportRoutes(
  app: FastifyInstance,
  auth: ApiAuthService,
  services: ApiAnalysisServices,
  knowledge: Pick<KnowledgeService, "submitMetric">,
): void {
  app.get("/metrics", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    z.object({}).strict().parse(request.query);
    return { items: await services.metrics.list(context) };
  });
  app.post("/admin/metrics", async (request, reply) =>
    reply
      .code(201)
      .send(
        await knowledge.submitMetric(await auth.loadContext(bearerToken(request)), request.body),
      ),
  );
  app.get("/metrics/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    return services.metrics.get(
      context,
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    );
  });
  app.post("/metrics/:id/execute", async (request) =>
    services.metrics.execute(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      request.body,
    ),
  );
  app.post("/reports", async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.reports.save(await auth.loadContext(bearerToken(request)), request.body),
      ),
  );
  app.get("/reports/:id", async (request) =>
    services.reports.get(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    ),
  );
  app.put("/reports/:id", async (request) => {
    const context = await auth.loadContext(bearerToken(request));
    const input = updateReportSchema.parse(request.body);
    return services.reports.save(
      context,
      input.report,
      paramsSchema.parse(request.params).id,
      input.expected_version,
    );
  });
}
export { registerMetricReportRoutes };
