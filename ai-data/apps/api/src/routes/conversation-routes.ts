import type { FastifyInstance, FastifyRequest } from "fastify";
import { createConversationSchema, submitMessageSchema } from "@ai-data/contracts";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error";
import type { ApiAuthService, ApiConversationService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import { bearerToken } from "./auth-routes";

/** 从 Access JWT 加载当前可信身份上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: ApiAuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 注册会话、消息与分析运行创建接口。 */
function registerConversationRoutes(
  app: FastifyInstance,
  authService: ApiAuthService,
  conversationService: ApiConversationService,
): void {
  app.post("/conversations", async (request, reply) => {
    const input = createConversationSchema.parse(request.body);
    return reply
      .code(201)
      .send(
        await conversationService.create(
          await currentContext(request, authService),
          input.title,
          ...(input.agent_id
            ? [{ agent_id: input.agent_id, agent_version: input.agent_version }]
            : []),
        ),
      );
  });
  app.get("/conversations", async (request, reply) => {
    return reply.send({
      items: await conversationService.list(await currentContext(request, authService)),
    });
  });
  app.post("/conversations/delete", async (request, reply) => {
    const input = z
      .object({ ids: z.array(z.string().min(1).max(128)).min(1).max(100) })
      .strict()
      .parse(request.body);
    await conversationService.delete(await currentContext(request, authService), input.ids);
    return reply.code(204).send();
  });
  app.delete("/conversations/:id", async (request, reply) => {
    await conversationService.delete(await currentContext(request, authService), [
      (request.params as { id: string }).id,
    ]);
    return reply.code(204).send();
  });
  app.get("/conversations/:id", async (request, reply) => {
    const detail = await conversationService.get(
      await currentContext(request, authService),
      (request.params as { id: string }).id,
    );
    if (!detail) throw new ApplicationError("NOT_FOUND", "会话不存在");
    return reply.send(detail);
  });
  app.post("/conversations/:id/messages", async (request, reply) => {
    const input = submitMessageSchema.parse(request.body);
    const submitted = await conversationService.submitUserMessage(
      await currentContext(request, authService),
      (request.params as { id: string }).id,
      input.content,
      input.idempotency_key,
    );
    if (!submitted) throw new ApplicationError("NOT_FOUND", "会话不存在或不可用");
    return reply.code(201).send(submitted);
  });
}

export { registerConversationRoutes };
