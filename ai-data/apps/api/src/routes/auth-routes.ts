import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiAuthService } from "../app-types";
import { ApplicationError } from "../errors/application-error";

/** 本地登录输入，拒绝未知字段；账号状态和密码正确性由认证服务判断。 */
const loginSchema = z
  .object({
    /** 本地账号登录名。 */
    username: z.string().min(1),
    /** 用户提交的密码明文，仅用于本次校验。 */
    password: z.string().min(1),
  })
  .strict();
/** 刷新请求拒绝未知字段；省略 refresh_token 时从 HttpOnly Cookie 读取。 */
const refreshSchema = z.object({ refresh_token: z.string().min(1).optional() }).strict();

/** 从 Authorization 请求头提取 Bearer 令牌。 */
function bearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer "))
    throw new ApplicationError("AUTHENTICATION_FAILED", "缺少登录令牌");
  return value.slice("Bearer ".length);
}

/** 读取刷新 Cookie；编码损坏属于客户端输入错误，原始解析原因仅保留在服务端。 */
function refreshCookieToken(request: FastifyRequest): string | undefined {
  const encoded = request.headers.cookie?.match(/(?:^|; )refresh_token=([^;]+)/)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch (cause) {
    throw new ApplicationError("INVALID_INPUT", "刷新令牌格式无效", { cause });
  }
}

/** 刷新令牌 Cookie 仅用于 /auth 路径；生产环境启用 Secure，HttpOnly 限制脚本读取。 */
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
  authService: ApiAuthService,
  secureCookie = true,
): void {
  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await authService.login(input.username, input.password);
    setRefreshCookie(reply, result.refreshToken, secureCookie);
    return reply.send(result);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const input = refreshSchema.parse(request.body ?? {});
    const token = input.refresh_token ?? refreshCookieToken(request);
    if (!token) throw new ApplicationError("AUTHENTICATION_FAILED", "缺少刷新令牌");
    const result = await authService.refresh(token);
    setRefreshCookie(reply, result.refreshToken, secureCookie);
    return reply.send(result);
  });

  app.post("/auth/logout", async (request, reply) => {
    const claims = await authService.loadContext(bearerToken(request));
    await authService.logout(claims.sessionId);
    reply.header(
      "set-cookie",
      `refresh_token=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie ? "; Secure" : ""}`,
    );
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    const context = await authService.loadContext(bearerToken(request));
    return reply.send(context);
  });
}

export { bearerToken, registerAuthRoutes };
