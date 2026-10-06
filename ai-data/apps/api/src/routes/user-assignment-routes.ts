import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  managedUserAuthorizationSchema,
  managedRoleSchema,
  userAssignmentOptionsSchema,
} from "@ai-data/contracts";
import type { ApiAuthService } from "../app-types";
import type { SqlUserAdminReader } from "../auth/sql-user-admin-reader";
import { ApplicationError } from "../errors/application-error";
import { bearerToken } from "./auth-routes";

/** 组织选项由服务端读取，用户管理与目录角色读取分别授权。 */
function registerUserAssignmentRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext" | "refreshContext">,
  reader: Pick<SqlUserAdminReader, "options" | "roles" | "authorization">,
): void {
  const empty = z.object({}).strict();
  const params = z.object({ id: z.string().min(1).max(128) }).strict();
  app.get("/admin/users/assignment-options", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    if (!context.roles.includes("system_admin") && !context.permissions.includes("user:manage"))
      throw new ApplicationError("UNAUTHORIZED", "无用户管理权限");
    empty.parse(request.query);
    return userAssignmentOptionsSchema.parse(
      await reader.options(context.organizationId, context.roles.includes("system_admin")),
    );
  });
  app.get("/admin/users/:id/authorization", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    if (!context.roles.includes("system_admin") && !context.permissions.includes("user:manage"))
      throw new ApplicationError("UNAUTHORIZED", "无用户管理权限");
    empty.parse(request.query);
    return managedUserAuthorizationSchema.parse(
      await reader.authorization(context.organizationId, params.parse(request.params).id),
    );
  });
  app.get("/admin/catalog/role-options", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    if (!context.roles.includes("system_admin") && !context.permissions.includes("catalog:manage"))
      throw new ApplicationError("UNAUTHORIZED", "无目录管理权限");
    empty.parse(request.query);
    return { items: managedRoleSchema.array().parse(await reader.roles(context.organizationId)) };
  });
}
export { registerUserAssignmentRoutes };
