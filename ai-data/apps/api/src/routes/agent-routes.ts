import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AgentService } from "../agents/agent-service";
import type { ApiAuthService } from "../app-types";
import { bearerToken } from "./auth-routes";

/** 管理路由仅接受本接口声明的参数，组织范围由认证上下文提供。 */
const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
/** 省略版本时读取最新版本。 */
const versionSchema = z.object({ version: z.coerce.number().int().positive().optional() }).strict();
/** 清单接口当前返回本组织最新配置，不接收客户端组织参数。 */
const listSchema = z.object({}).strict();
/** 启停作用于 Agent 当前状态，不修改配置版本。 */
const statusSchema = z.object({ enabled: z.boolean() }).strict();

/** Agent 发布、读取和启停 HTTP 边界。 */
function registerAgentRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext" | "refreshContext">,
  service: Pick<AgentService, "publish" | "get" | "list" | "setEnabled">,
): void {
  app.post("/agents", async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .code(201)
      .send(
        await service.publish(
          await auth.refreshContext(await auth.loadContext(bearerToken(request))),
          request.body,
        ),
      ),
  );
  app.get("/agents", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    listSchema.parse(request.query);
    return { items: await service.list(context) };
  });
  app.get("/agents/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.get(
      await auth.refreshContext(await auth.loadContext(bearerToken(request))),
      paramsSchema.parse(request.params).id,
      versionSchema.parse(request.query).version,
    );
  });
  app.patch("/agents/:id/status", async (request, reply) => {
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    await service.setEnabled(
      context,
      paramsSchema.parse(request.params).id,
      statusSchema.parse(request.body).enabled,
    );
    return reply.header("cache-control", "no-store").code(204).send();
  });
}

export { registerAgentRoutes };
