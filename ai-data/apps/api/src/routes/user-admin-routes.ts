import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AuthService } from "../auth/auth-service";
import type { AuthContext } from "../auth/auth-types";
import { hashPassword } from "../auth/password";
import { bearerToken } from "./auth-routes";

/** 管理员创建用户请求体。 */
const createUserSchema = z
  .object({
    /** 组织内唯一登录名。 */
    username: z.string().min(1),
    /** 用户展示名称。 */
    display_name: z.string().min(1),
    /** 初始密码，服务端保存为派生哈希。 */
    password: z.string().min(8),
    /** 要绑定的角色标识。 */
    role_ids: z.array(z.string().min(1)).default([]),
    /** 仅用于个别例外的数据范围标识。常规范围由角色继承。 */
    exception_data_scope_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** 校验当前身份是否具备用户管理权限。 */
function requireAdmin(context: AuthContext): void {
  if (!context.permissions.includes("user:manage") && !context.roles.includes("system_admin"))
    throw new Error("无用户管理权限");
}

/** 从请求令牌加载当前用户上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: AuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 注册管理员用户维护接口。 */
function registerUserAdminRoutes(app: FastifyInstance, authService: AuthService): void {
  app.post("/admin/users", async (request, reply) => {
    try {
      const context = await currentContext(request, authService);
      requireAdmin(context);
      const input = createUserSchema.parse(request.body);
      const user = await authService.createManagedUser({
        id: crypto.randomUUID(),
        organizationId: context.organizationId,
        username: input.username,
        displayName: input.display_name,
        passwordHash: await hashPassword(input.password),
        roleIds: input.role_ids,
        exceptionDataScopeIds: input.exception_data_scope_ids,
      });
      return reply.code(201).send(publicUser(user));
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "用户参数无效" });
      if (
        error instanceof Error &&
        ["缺少登录令牌", "登录会话无效", "无用户管理权限"].includes(error.message)
      )
        return reply.code(403).send({ code: "FORBIDDEN", message: error.message });
      return reply.code(409).send({ code: "USER_CREATE_FAILED", message: "用户创建失败" });
    }
  });

  app.get("/admin/users", async (request, reply) => {
    try {
      const context = await currentContext(request, authService);
      requireAdmin(context);
      const users = await authService.listManagedUsers(context.organizationId);
      return reply.send({ items: users.map(publicUser) });
    } catch (error) {
      return reply
        .code(403)
        .send({ code: "FORBIDDEN", message: error instanceof Error ? error.message : "无权限" });
    }
  });

  app.get("/admin/users/:id", async (request, reply) => {
    try {
      const context = await currentContext(request, authService);
      requireAdmin(context);
      const user = await authService.findManagedUser((request.params as { id: string }).id);
      if (!user || user.organizationId !== context.organizationId)
        return reply.code(404).send({ code: "NOT_FOUND", message: "用户不存在" });
      return reply.send(publicUser(user));
    } catch (error) {
      return reply
        .code(403)
        .send({ code: "FORBIDDEN", message: error instanceof Error ? error.message : "无权限" });
    }
  });

  for (const [action, status] of [
    ["disable", "disabled"],
    ["enable", "active"],
  ] as const) {
    app.post(`/admin/users/:id/${action}`, async (request, reply) => {
      try {
        const context = await currentContext(request, authService);
        requireAdmin(context);
        const updated = await authService.updateManagedUserStatus(
          (request.params as { id: string }).id,
          context.organizationId,
          status,
        );
        if (!updated) return reply.code(404).send({ code: "NOT_FOUND", message: "用户不存在" });
        return reply.code(204).send();
      } catch (error) {
        return reply
          .code(403)
          .send({ code: "FORBIDDEN", message: error instanceof Error ? error.message : "无权限" });
      }
    });
  }
}

/** 将用户领域对象转换为不含密码信息的接口响应。 */
function publicUser(user: {
  id: string;
  organizationId: string;
  username: string;
  displayName: string;
  status: string;
  authorizationVersion: number;
}) {
  return {
    id: user.id,
    organization_id: user.organizationId,
    username: user.username,
    display_name: user.displayName,
    status: user.status,
    authorization_version: user.authorizationVersion,
  };
}

export { registerUserAdminRoutes };
