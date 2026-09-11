import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthService } from "../auth/auth-service";

/** 登录请求体。 */
const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();
/** 刷新令牌请求体。 */
const refreshSchema = z.object({ refresh_token: z.string().min(1).optional() }).strict();

/** 从 Authorization 请求头提取 Bearer 令牌。 */
function bearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new Error("缺少登录令牌");
  return value.slice("Bearer ".length);
}

/** 设置 Refresh Token HttpOnly Cookie。 */
function setRefreshCookie(
  reply: { header(name: string, value: string): unknown },
  token: string,
  secure: boolean,
): void {
  reply.header(
    "set-cookie",
    `refresh_token=${encodeURIComponent(token)}; Path=/auth; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
}

/** 注册本地登录、刷新、注销和当前用户接口。 */
function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  secureCookie = true,
): void {
  app.post("/auth/login", async (request, reply) => {
    try {
      const input = loginSchema.parse(request.body);
      const result = await authService.login(input.username, input.password);
      setRefreshCookie(reply, result.refreshToken, secureCookie);
      return reply.send(result);
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "账号或密码错误" });
    }
  });

  app.post("/auth/refresh", async (request, reply) => {
    const input = refreshSchema.parse(request.body ?? {});
    const cookie = request.headers.cookie?.match(/(?:^|; )refresh_token=([^;]+)/)?.[1];
    const token = input.refresh_token ?? (cookie ? decodeURIComponent(cookie) : undefined);
    if (!token) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "缺少刷新令牌" });
    try {
      const result = await authService.refresh(token);
      setRefreshCookie(reply, result.refreshToken, secureCookie);
      return reply.send(result);
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "刷新令牌无效或已过期" });
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    let claims;
    try {
      claims = await authService.loadContext(bearerToken(request));
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "登录令牌无效" });
    }
    await authService.logout(claims.sessionId);
    reply.header(
      "set-cookie",
      `refresh_token=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie ? "; Secure" : ""}`,
    );
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    try {
      const context = await authService.loadContext(bearerToken(request));
      return reply.send(context);
    } catch {
      return reply.code(401).send({ code: "UNAUTHENTICATED", message: "登录令牌无效" });
    }
  });
}

export { bearerToken, registerAuthRoutes };
