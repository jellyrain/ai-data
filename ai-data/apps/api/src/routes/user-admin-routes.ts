import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createManagedUserSchema, managedDepartmentsInputSchema } from "@ai-data/contracts";

import { ApplicationError } from "../errors/application-error";
import type { ApiAuthService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import { hashPassword } from "../auth/password";
import { bearerToken } from "./auth-routes";

/** 用户路径参数沿用元数据 ID 长度，拒绝额外字段。 */
const userParamsSchema = z.object({ id: z.string().min(1).max(128) }).strict();

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
  return authService.refreshContext(await authService.loadContext(bearerToken(request)));
}

/** 注册管理员用户维护接口。 */
function registerUserAdminRoutes(app: FastifyInstance, authService: ApiAuthService): void {
  app.put("/admin/users/:id/departments", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const input = managedDepartmentsInputSchema.parse(request.body);
    const updated = await authService.updateManagedUserDepartments(
      userParamsSchema.parse(request.params).id,
      context.organizationId,
      input.department_ids,
      input.expected_authorization_version,
    );
    if (!updated) throw new ApplicationError("NOT_FOUND", "用户不存在");
    return reply.code(204).send();
  });

  app.post("/admin/users", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const input = createManagedUserSchema.parse(request.body);
    const user = await authService.createManagedUser({
      id: crypto.randomUUID(),
      organizationId: context.organizationId,
      username: input.username,
      displayName: input.display_name,
      passwordHash: await hashPassword(input.password),
      roleIds: input.role_ids,
      exceptionDataScopeIds: input.exception_data_scope_ids,
      assignmentAuthority: { canAssignPrivileged: context.roles.includes("system_admin") },
    });
    return reply.code(201).send(publicUser(user));
  });

  app.get("/admin/users", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const users = await authService.listManagedUsers(context.organizationId);
    return reply.send({ items: users.map(publicUser) });
  });

  app.get("/admin/users/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await currentContext(request, authService);
    requireAdmin(context);
    const user = await authService.findManagedUser(userParamsSchema.parse(request.params).id);
    if (!user || user.organizationId !== context.organizationId)
      throw new ApplicationError("NOT_FOUND", "用户不存在");
    return reply.send(publicUser(user));
  });

  for (const [action, status] of [
    ["disable", "disabled"],
    ["enable", "active"],
  ] as const) {
    app.post(`/admin/users/:id/${action}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const context = await currentContext(request, authService);
      requireAdmin(context);
      const updated = await authService.updateManagedUserStatus(
        userParamsSchema.parse(request.params).id,
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
