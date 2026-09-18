import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error";
import type { ApiAuthService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import { hashPassword } from "../auth/password";
import { departmentIdsSchema } from "../auth/department-scope";
import { bearerToken } from "./auth-routes";

/** 管理员创建用户输入，拒绝未知字段；组织归属从当前身份取得。 */
const createUserSchema = z
  .object({
    /** 组织内唯一登录名。 */
    username: z.string().min(1),
    /** 用户展示名称。 */
    display_name: z.string().min(1),
    /** 初始密码，服务端保存为派生哈希。 */
    password: z.string().min(8),
    /** 初始角色标识；省略时不建立角色绑定。 */
    role_ids: z.array(z.string().min(1)).default([]),
    /** 初始用户例外范围；省略时仅使用角色继承的数据范围。 */
    exception_data_scope_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** 校验当前身份是否具备用户管理权限。 */
function requireAdmin(context: AuthContext): void {
  if (!context.permissions.includes("user:manage") && !context.roles.includes("system_admin"))
    throw new ApplicationError("UNAUTHORIZED", "无用户管理权限");
}

/** 从请求令牌加载当前用户上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: ApiAuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 注册管理员用户维护接口。 */
function registerUserAdminRoutes(app: FastifyInstance, authService: ApiAuthService): void {
  app.put("/admin/users/:id/departments", async (request, reply) => {
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const input = z.object({ department_ids: departmentIdsSchema }).strict().parse(request.body);
    const updated = await authService.updateManagedUserDepartments(
      (request.params as { id: string }).id,
      context.organizationId,
      input.department_ids,
    );
    if (!updated) throw new ApplicationError("NOT_FOUND", "用户不存在");
    return reply.code(204).send();
  });

  app.post("/admin/users", async (request, reply) => {
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
  });

  app.get("/admin/users", async (request, reply) => {
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const users = await authService.listManagedUsers(context.organizationId);
    return reply.send({ items: users.map(publicUser) });
  });

  app.get("/admin/users/:id", async (request, reply) => {
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const user = await authService.findManagedUser((request.params as { id: string }).id);
    if (!user || user.organizationId !== context.organizationId)
      throw new ApplicationError("NOT_FOUND", "用户不存在");
    return reply.send(publicUser(user));
  });

  for (const [action, status] of [
    ["disable", "disabled"],
    ["enable", "active"],
  ] as const) {
    app.post(`/admin/users/:id/${action}`, async (request, reply) => {
      const context = await currentContext(request, authService);
      requireAdmin(context);
      const updated = await authService.updateManagedUserStatus(
        (request.params as { id: string }).id,
        context.organizationId,
        status,
      );
      if (!updated) throw new ApplicationError("NOT_FOUND", "用户不存在");
      return reply.code(204).send();
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
