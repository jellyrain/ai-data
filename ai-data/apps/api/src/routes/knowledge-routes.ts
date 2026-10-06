import { z } from "zod";
import {
  knowledgeCandidateInputSchema,
  memoryScopeSchema,
  knowledgeOwnerOptionsInputSchema,
} from "@ai-data/contracts";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { KnowledgeService } from "../knowledge/knowledge-service";
import { bearerToken } from "./auth-routes";
/** 路径、版本与状态动作只接受公开字段，归属由认证上下文确定。 */
const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const versionSchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict();
const emptyQuerySchema = z.object({}).strict();
const expectedVersionSchema = z.object({ expected_version: z.number().int().positive() }).strict();
const assignOwnerSchema = expectedVersionSchema
  .extend({ owner_id: z.string().min(1).max(128) })
  .strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();
/** HTTP 依赖知识领域公开能力，读取与动作都复核当前账号。 */
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
  | "listManagement"
  | "getManagement"
  | "ownerOptions"
  | "templateDefinition"
>;
/** 候选审核与正式版本操作按当前组织和负责人权限执行。 */
function registerKnowledgeRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext" | "refreshContext">,
  service: KnowledgeRouteService,
): void {
  const context = async (request: FastifyRequest, reply: FastifyReply, allowQuery = false) => {
    reply.header("cache-control", "no-store");
    const value = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    if (!allowQuery) emptyQuerySchema.parse(request.query);
    return value;
  };
  const id = (request: FastifyRequest) => paramsSchema.parse(request.params).id;
  app.post("/knowledge-candidates", async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.submit(
          await context(request, reply),
          knowledgeCandidateInputSchema.parse(request.body),
        ),
      ),
  );
  app.get("/knowledge-candidates", async (request, reply) => ({
    items: await service.listCandidates(await context(request, reply)),
  }));
  app.get("/knowledge-candidates/:id", async (request, reply) =>
    service.getCandidate(await context(request, reply), id(request)),
  );
  app.put("/knowledge-candidates/:id", async (request, reply) =>
    service.update(await context(request, reply), id(request), request.body),
  );
  app.post("/knowledge-candidates/:id/withdraw", async (request, reply) =>
    service.withdraw(
      await context(request, reply),
      id(request),
      expectedVersionSchema.parse(request.body).expected_version,
    ),
  );
  app.post("/knowledge-candidates/:id/sources", async (request, reply) =>
    service.support(await context(request, reply), id(request), request.body),
  );
  app.get("/knowledge-candidates/:id/sources", async (request, reply) => ({
    items: await service.listSources(await context(request, reply), id(request)),
  }));
  app.get("/knowledge-candidates/:id/template-definition", async (request, reply) =>
    service.templateDefinition(await context(request, reply), id(request)),
  );
  app.get("/admin/knowledge-candidates", async (request, reply) => ({
    items: await service.listCandidates(await context(request, reply), true),
  }));
  app.post("/admin/knowledge-candidates/:id/review", async (request, reply) =>
    service.review(await context(request, reply), id(request), request.body),
  );
  app.get("/admin/knowledge-candidates/:id/reviews", async (request, reply) => ({
    items: await service.listReviews(await context(request, reply), id(request)),
  }));
  app.post("/admin/knowledge-candidates/:id/publish", async (request, reply) =>
    reply
      .code(201)
      .send(await service.publish(await context(request, reply), id(request), request.body)),
  );
  app.get("/knowledge", async (request, reply) => ({
    items: await service.listPublished(
      await context(request, reply, true),
      memoryScopeSchema.parse(request.query),
    ),
  }));
  app.get("/knowledge/:id", async (request, reply) =>
    service.getPublished(
      await context(request, reply, true),
      id(request),
      versionSchema.parse(request.query).version,
    ),
  );
  app.get("/admin/knowledge", async (request, reply) => ({
    items: await service.listManagement(await context(request, reply)),
  }));
  app.get("/admin/knowledge/owner-options", async (request, reply) => ({
    items: await service.ownerOptions(
      await context(request, reply, true),
      knowledgeOwnerOptionsInputSchema.parse(request.query),
    ),
  }));
  app.get("/admin/knowledge/:id", async (request, reply) =>
    service.getManagement(await context(request, reply), id(request)),
  );
  app.get("/admin/knowledge/:id/versions", async (request, reply) => ({
    items: await service.listVersions(await context(request, reply), id(request)),
  }));
  app.post("/admin/knowledge/:id/rollback", async (request, reply) =>
    reply
      .code(201)
      .send(await service.rollback(await context(request, reply), id(request), request.body)),
  );
  app.post("/admin/knowledge-candidates/:id/owner", async (request, reply) => {
    const user = await context(request, reply);
    const input = assignOwnerSchema.parse(request.body);
    return service.assignOwner(user, id(request), input.owner_id, input.expected_version);
  });
  app.put("/admin/knowledge/:id/enabled", async (request, reply) => {
    await service.setEnabled(
      await context(request, reply),
      id(request),
      enabledSchema.parse(request.body).enabled,
    );
    return reply.code(204).send();
  });
}
export { registerKnowledgeRoutes };
