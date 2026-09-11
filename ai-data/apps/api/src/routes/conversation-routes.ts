import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthContext } from "../auth/auth-types";
import { AuthService } from "../auth/auth-service";
import { ConversationService } from "../conversations/conversation-service";
import { bearerToken } from "./auth-routes";

/** 创建会话请求体。 */
const createConversationSchema = z
  .object({ title: z.string().min(1).max(512).optional() })
  .strict();
/** 提交用户消息请求体。 */
const submitMessageSchema = z.object({ content: z.string().min(1) }).strict();

/** 从 Access JWT 加载当前可信身份上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: AuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 注册会话、消息与分析运行创建接口。 */
function registerConversationRoutes(
  app: FastifyInstance,
  authService: AuthService,
  conversationService: ConversationService,
): void {
  app.post("/conversations", async (request, reply) => {
    try {
      return reply
        .code(201)
        .send(
          await conversationService.create(
            await currentContext(request, authService),
            createConversationSchema.parse(request.body).title,
          ),
        );
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 401).send({
        code: error instanceof z.ZodError ? "INVALID_ARGUMENT" : "UNAUTHENTICATED",
        message: error instanceof z.ZodError ? "会话参数无效" : "登录令牌无效",
      });
    }
  });
  app.get("/conversations", async (request, reply) => {
    try {
      return reply.send({
        items: await conversationService.list(await currentContext(request, authService)),
      });
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "登录令牌无效" });
    }
  });
  app.get("/conversations/:id", async (request, reply) => {
    try {
      const detail = await conversationService.get(
        await currentContext(request, authService),
        (request.params as { id: string }).id,
      );
      return detail
        ? reply.send(detail)
        : reply.code(404).send({ code: "NOT_FOUND", message: "会话不存在" });
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "登录令牌无效" });
    }
  });
  app.post("/conversations/:id/messages", async (request, reply) => {
    try {
      const submitted = await conversationService.submitUserMessage(
        await currentContext(request, authService),
        (request.params as { id: string }).id,
        submitMessageSchema.parse(request.body).content,
      );
      return submitted
        ? reply.code(201).send(submitted)
        : reply.code(404).send({ code: "NOT_FOUND", message: "会话不存在或不可用" });
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 401).send({
        code: error instanceof z.ZodError ? "INVALID_ARGUMENT" : "UNAUTHENTICATED",
        message: error instanceof z.ZodError ? "消息参数无效" : "登录令牌无效",
      });
    }
  });
}

export { registerConversationRoutes };
