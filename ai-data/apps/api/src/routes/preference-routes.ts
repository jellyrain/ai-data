import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { saveUserPreferenceInputSchema } from "@ai-data/contracts";
import type { ApiAuthService } from "../app-types";
import type { PreferenceService } from "../preferences/preference-service";
import { bearerToken } from "./auth-routes";

/** 个人偏好键由路由提供，组织和账号始终来自认证上下文。 */
const paramsSchema = z.object({ key: z.string().min(1).max(128) }).strict();
/** 清单和详情当前只读取当前版本，拒绝所有额外筛选和归属参数。 */
const querySchema = z.object({}).strict();
/** 保存合同沿用共享字段，在合并路由键后再执行完整跨字段校验。 */
const saveBodySchema = z
  .object({
    scope: saveUserPreferenceInputSchema.shape.scope,
    value: saveUserPreferenceInputSchema.shape.value,
    auto_apply: saveUserPreferenceInputSchema.shape.auto_apply,
    expected_version: saveUserPreferenceInputSchema.shape.expected_version,
    idempotency_key: saveUserPreferenceInputSchema.shape.idempotency_key,
  })
  .strict();
/** 管理动作必须绑定用户正在查看的版本。 */
const mutationSchema = z
  .object({
    expected_version: z.number().int().positive(),
    idempotency_key: z.string().min(1).max(128),
  })
  .strict();
/** 自动应用状态是当前用户的明确设置。 */
const autoApplySchema = mutationSchema.extend({ auto_apply: z.boolean() }).strict();

/** 当前账号偏好的 HTTP 管理边界，直接用户操作由此赋予可信 user 来源。 */
function registerPreferenceRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext" | "refreshContext">,
  service: Pick<
    PreferenceService,
    "editState" | "list" | "listPendingConfirmations" | "get" | "save" | "delete" | "setAutoApply"
  >,
): void {
  const currentContext = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    return auth.refreshContext(await auth.loadContext(bearerToken(request)));
  };
  app.get("/me/preferences/:key/edit-state", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    return service.editState(context, paramsSchema.parse(request.params).key);
  });
  app.get("/me/preferences", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    return { items: await service.list(context) };
  });
  app.get("/me/preferences/:key", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    return service.get(context, paramsSchema.parse(request.params).key);
  });
  app.get("/me/preferences/confirmations", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    return { items: await service.listPendingConfirmations(context) };
  });
  app.put("/me/preferences/:key", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    const input = saveUserPreferenceInputSchema.parse({
      ...saveBodySchema.parse(request.body),
      key: paramsSchema.parse(request.params).key,
    });
    return service.save(context, input, { origin: "user" });
  });
  app.delete("/me/preferences/:key", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    await service.delete(
      context,
      paramsSchema.parse(request.params).key,
      mutationSchema.parse(request.body),
    );
    return reply.code(204).send();
  });
  app.patch("/me/preferences/:key/auto-apply", async (request, reply) => {
    const context = await currentContext(request, reply);
    querySchema.parse(request.query);
    return service.setAutoApply(
      context,
      paramsSchema.parse(request.params).key,
      autoApplySchema.parse(request.body),
    );
  });
}

export { registerPreferenceRoutes };
