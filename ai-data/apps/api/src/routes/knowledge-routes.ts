import { z } from "zod";
import { knowledgeCandidateInputSchema, memoryScopeSchema } from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { KnowledgeService } from "../knowledge/knowledge-service";
import { bearerToken } from "./auth-routes";

const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const versionSchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict();
const expectedVersionSchema = z.object({ expected_version: z.number().int().positive() }).strict();
const assignOwnerSchema = expectedVersionSchema
  .extend({ owner_id: z.string().min(1).max(128) })
  .strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();
/** HTTP 只依赖知识领域公开能力；身份在每次请求从认证服务重新加载。 */
type KnowledgeRouteService = Pick<
  KnowledgeService,
  | "submit"
  | "listCandidates"
  | "getCandidate"
  | "update"
  | "withdraw"
  | "support"
  | "listSources"
  | "assignOwner"
  | "review"
  | "publish"
  | "listReviews"
  | "listPublished"
  | "getPublished"
  | "listVersions"
  | "setEnabled"
  | "rollback"
>;
/** 候选审核与正式版本操作按当前组织和负责人权限执行。 */
function registerKnowledgeRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext">,
  service: KnowledgeRouteService,
): void {
  app.post("/knowledge-candidates", async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.submit(
          await auth.loadContext(bearerToken(request)),
          knowledgeCandidateInputSchema.parse(request.body),
        ),
      ),
  );
  app.get("/knowledge-candidates", async (request) => ({
    items: await service.listCandidates(await auth.loadContext(bearerToken(request))),
  }));
  app.get("/knowledge-candidates/:id", async (request) =>
    service.getCandidate(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  );
  app.put("/knowledge-candidates/:id", async (request) =>
    service.update(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      request.body,
    ),
  );
  app.post("/knowledge-candidates/:id/withdraw", async (request) =>
    service.withdraw(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      expectedVersionSchema.parse(request.body).expected_version,
    ),
  );
  app.post("/knowledge-candidates/:id/sources", async (request) =>
    service.support(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      request.body,
    ),
  );
  app.get("/knowledge-candidates/:id/sources", async (request) => ({
    items: await service.listSources(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  }));
  app.get("/admin/knowledge-candidates", async (request) => ({
    items: await service.listCandidates(await auth.loadContext(bearerToken(request)), true),
  }));
  app.post("/admin/knowledge-candidates/:id/owner", async (request) => {
    const input = assignOwnerSchema.parse(request.body);
    return service.assignOwner(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      input.owner_id,
      input.expected_version,
    );
  });
  app.post("/admin/knowledge-candidates/:id/review", async (request) =>
    service.review(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      request.body,
    ),
  );
  app.get("/admin/knowledge-candidates/:id/reviews", async (request) => ({
    items: await service.listReviews(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  }));
  app.post("/admin/knowledge-candidates/:id/publish", async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.publish(
          await auth.loadContext(bearerToken(request)),
          paramsSchema.parse(request.params).id,
          request.body,
        ),
      ),
  );
  app.get("/knowledge", async (request) => ({
    items: await service.listPublished(
      await auth.loadContext(bearerToken(request)),
      memoryScopeSchema.parse(request.query),
    ),
  }));
  app.get("/knowledge/:id", async (request) =>
    service.getPublished(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    ),
  );
  app.get("/admin/knowledge/:id/versions", async (request) => ({
    items: await service.listVersions(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  }));
  app.put("/admin/knowledge/:id/enabled", async (request, reply) => {
    await service.setEnabled(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      enabledSchema.parse(request.body).enabled,
    );
    return reply.code(204).send();
  });
  app.post("/admin/knowledge/:id/rollback", async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.rollback(
          await auth.loadContext(bearerToken(request)),
          paramsSchema.parse(request.params).id,
          request.body,
        ),
      ),
  );
}
export { registerKnowledgeRoutes };
