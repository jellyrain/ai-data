import { z } from "zod";
import {
  reportListInputSchema,
  saveReportDefinitionInputSchema,
  reportShareCandidatesInputSchema,
} from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { ReportDefinitionService } from "../reports/report-definition-service";
import type { ReportManagementService } from "../reports/report-management-service";
import type { ReportSharingService } from "../reports/report-sharing-service";
import { bearerToken } from "./auth-routes";

const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const versionSchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict();
const emptyQuerySchema = z.object({}).strict();
const updateSchema = saveReportDefinitionInputSchema.extend({
  expected_version: z.number().int().positive(),
});
/** 表单、画布及对话读取相同定义；公共修改只能更新已存在的正版本。 */
function registerReportManagementRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext" | "refreshContext">,
  services: {
    sharing: Pick<ReportSharingService, "get" | "candidates">;
    definitions: Pick<
      ReportDefinitionService,
      "save" | "get" | "saveBlock" | "getBlock" | "listBlocks" | "listTemplates"
    >;
    management: Pick<
      ReportManagementService,
      "list" | "versions" | "share" | "exportReport" | "artifacts" | "exportConversation"
    >;
  },
): void {
  app.get("/reports", async (request) =>
    services.management.list(await auth.loadContext(bearerToken(request)), request.query),
  );
  app.post("/report-definitions", async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.definitions.save(await auth.loadContext(bearerToken(request)), request.body),
      ),
  );
  app.get("/reports/:id/definition", async (request) =>
    services.definitions.get(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    ),
  );
  app.put("/reports/:id/definition", async (request) => {
    const { expected_version, ...input } = updateSchema.parse(request.body);
    return services.definitions.save(
      await auth.loadContext(bearerToken(request)),
      input,
      paramsSchema.parse(request.params).id,
      expected_version,
    );
  });
  app.get("/reports/:id/versions", async (request) =>
    services.management.versions(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  );
  app.get("/reports/:id/sharing", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    emptyQuerySchema.parse(request.query);
    return services.sharing.get(context, paramsSchema.parse(request.params).id);
  });
  app.get("/reports/:id/share-candidates", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    return services.sharing.candidates(
      context,
      paramsSchema.parse(request.params).id,
      reportShareCandidatesInputSchema.parse(request.query),
    );
  });
  app.put("/reports/:id/sharing", async (request) =>
    services.management.share(
      await auth.refreshContext(await auth.loadContext(bearerToken(request))),
      paramsSchema.parse(request.params).id,
      request.body,
    ),
  );
  app.get("/reports/:id/export-content", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return services.management.exportReport(
      await auth.refreshContext(await auth.loadContext(bearerToken(request))),
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    );
  });
  app.get("/report-blocks", async (request) =>
    services.definitions.listBlocks(
      await auth.loadContext(bearerToken(request)),
      reportListInputSchema.parse(request.query),
    ),
  );
  app.post("/report-blocks", async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.definitions.saveBlock(
          await auth.loadContext(bearerToken(request)),
          request.body,
        ),
      ),
  );
  app.get("/report-blocks/:id", async (request) =>
    services.definitions.getBlock(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    ),
  );
  app.put("/report-blocks/:id", async (request) => {
    const { expected_version, ...input } = updateSchema.parse(request.body);
    return services.definitions.saveBlock(
      await auth.loadContext(bearerToken(request)),
      input,
      paramsSchema.parse(request.params).id,
      expected_version,
    );
  });
  app.get("/report-templates", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    emptyQuerySchema.parse(request.query);
    return { items: await services.definitions.listTemplates(context) };
  });
  app.get("/analysis-runs/:id/artifacts", async (request) => ({
    items: await services.management.artifacts(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  }));
  app.get("/conversations/:id/export-content", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    emptyQuerySchema.parse(request.query);
    return services.management.exportConversation(context, paramsSchema.parse(request.params).id);
  });
}
export { registerReportManagementRoutes };
