import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error";
import type { ApiAuthService, ApiConversationService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import { bearerToken } from "./auth-routes";

/** 创建会话输入，拒绝未知字段；标题省略时由服务保存为 null，长度限制对应持久化列。 */
const createConversationSchema = z
  .object({ title: z.string().min(1).max(512).optional() })
  .strict();
/** 用户消息输入，正文必须非空，拒绝未声明字段。 */
const submitMessageSchema = z.object({ content: z.string().min(1) }).strict();

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
    return reply
      .code(201)
      .send(
        await conversationService.create(
          await currentContext(request, authService),
          createConversationSchema.parse(request.body).title,
        ),
      );
  });
  app.get("/conversations", async (request, reply) => {
    return reply.send({
      items: await conversationService.list(await currentContext(request, authService)),
    });
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
    const submitted = await conversationService.submitUserMessage(
      await currentContext(request, authService),
      (request.params as { id: string }).id,
      submitMessageSchema.parse(request.body).content,
    );
    if (!submitted) throw new ApplicationError("NOT_FOUND", "会话不存在或不可用");
    return reply.code(201).send(submitted);
  });
}

export { registerConversationRoutes };
