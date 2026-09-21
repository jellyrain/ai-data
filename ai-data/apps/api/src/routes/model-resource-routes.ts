import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApiAuthService, ApiAgentServices } from "../app-types";
import { toolDescriptions } from "../runtime/tool-contracts";
import { bearerToken } from "./auth-routes";

/** 资源列表不允许客户端提供组织范围；详情版本省略时返回当前版本。 */
const emptySchema = z.object({}).strict();
const idSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const versionSchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict();
const statusSchema = z.object({ enabled: z.boolean() }).strict();
/** Skill 阅读只接收源库中的资源路径，实际路径由资源读取器验证。 */
const skillQuerySchema = z.object({ path: z.string().min(1).max(512).optional() }).strict();

/** 模型管理只返回公开配置，认证数据交由服务端凭据存储处理。 */
function registerModelResourceRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext">,
  services: Pick<ApiAgentServices, "models" | "skills">,
): void {
  const { models, skills } = services;
  app.post("/models", async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .code(201)
      .send(await models.publish(await auth.loadContext(bearerToken(request)), request.body)),
  );
  app.get("/models", async (request, reply) => {
    const context = await auth.loadContext(bearerToken(request));
    emptySchema.parse(request.query);
    return reply.header("cache-control", "no-store").send({ items: await models.list(context) });
  });
  app.get("/models/:id", async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .send(
        await models.get(
          await auth.loadContext(bearerToken(request)),
          idSchema.parse(request.params).id,
          versionSchema.parse(request.query).version,
        ),
      ),
  );
  app.patch("/models/:id/status", async (request, reply) => {
    await models.setEnabled(
      await auth.loadContext(bearerToken(request)),
      idSchema.parse(request.params).id,
      statusSchema.parse(request.body).enabled,
    );
    return reply.code(204).send();
  });
  app.get("/skills", async (request, reply) => {
    await auth.loadContext(bearerToken(request));
    emptySchema.parse(request.query);
    return reply.header("cache-control", "no-store").send({ items: skills.list() });
  });
  app.get("/skills/:id", async (request, reply) => {
    await auth.loadContext(bearerToken(request));
    return reply
      .header("cache-control", "no-store")
      .send(
        skills.read(idSchema.parse(request.params).id, skillQuerySchema.parse(request.query).path),
      );
  });
  app.get("/agent-tools", async (request) => {
    await auth.loadContext(bearerToken(request));
    emptySchema.parse(request.query);
    return {
      items: Object.entries(toolDescriptions).map(([name, description]) => ({ name, description })),
    };
  });
}

export { registerModelResourceRoutes };
