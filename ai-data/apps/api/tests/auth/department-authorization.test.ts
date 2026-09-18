import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { AuthService } from "../../src/auth/auth-service";
import { AuthContextCache } from "../../src/auth/auth-context-cache";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { registerUserAdminRoutes } from "../../src/routes/user-admin-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { context, createApiDependencies } from "../support/api-fixtures";

describe("可信部门权限范围", () => {
  it("长运行刷新从仓储读取当前范围，撤销会话后立即拒绝", async () => {
    const repository = {
      findUserById: vi.fn(async () => ({ id: "user", organizationId: "org", status: "active" })),
      findSessionById: vi.fn(async () => ({
        id: "session",
        userId: "user",
        expiresAt: new Date(Date.now() + 60000),
        revokedAt: null as Date | null,
      })),
      loadAuthorization: vi.fn(async () => ({
        roles: [],
        roleIds: [],
        permissions: [],
        dataPolicies: [],
        permissionContext: { department_ids: ["B"] },
      })),
    };
    const service = new AuthService({ repository } as unknown as ConstructorParameters<
      typeof AuthService
    >[0]);
    expect(
      (await service.refreshContext({ ...context, permissionContext: { department_ids: ["A"] } }))
        .permissionContext,
    ).toEqual({ department_ids: ["B"] });
    repository.findSessionById.mockResolvedValue({
      id: "session",
      userId: "user",
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: new Date(),
    });
    await expect(service.refreshContext(context)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });
  it("授权仓储从用户部门绑定读取可信集合", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ department_id: "A" }, { department_id: "B" }] });
    const result = await new SqlAuthRepository({ execute }).loadAuthorization("user");
    expect(result.permissionContext).toEqual({ department_ids: ["A", "B"] });
    expect(execute.mock.calls[2][0].parameters).toContainEqual({
      name: "user_id",
      type: "string",
      value: "user",
    });
  });

  it("范围更新后清除用户身份缓存", async () => {
    const cache = new AuthContextCache();
    cache.set(context.sessionId, context);
    const repository = { updateUserDepartments: vi.fn(async () => true) };
    const service = new AuthService({
      repository,
      contextCache: cache,
    } as unknown as ConstructorParameters<typeof AuthService>[0]);
    await expect(service.updateManagedUserDepartments("user", "org", ["A"])).resolves.toBe(true);
    expect(cache.get(context.sessionId)).toBeNull();
    expect(repository.updateUserDepartments).toHaveBeenCalledWith("user", "org", ["A"]);
  });

  it.each([
    { departments: ["A", "B"], status: 204 },
    { departments: [], status: 204 },
    { departments: ["A", "A"], status: 400 },
    { departments: [""], status: 400 },
  ])("管理员维护部门集合 $departments", async ({ departments, status }) => {
    const dependencies = createApiDependencies();
    const update = vi.fn(async () => true);
    const auth = { ...dependencies.auth, updateManagedUserDepartments: update };
    const app = Fastify();
    registerContractErrorHandler(app);
    registerUserAdminRoutes(app, auth);
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/users/member/departments",
        headers: { authorization: "Bearer test" },
        payload: { department_ids: departments },
      });
      expect(response.statusCode).toBe(status);
      if (status === 204) expect(update).toHaveBeenCalledWith("member", "org", departments);
      else expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("普通用户不能维护部门授权", async () => {
    const dependencies = createApiDependencies();
    dependencies.auth.loadContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
    const update = vi.fn(async () => true);
    const app = Fastify();
    registerContractErrorHandler(app);
    registerUserAdminRoutes(app, { ...dependencies.auth, updateManagedUserDepartments: update });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/users/member/departments",
        headers: { authorization: "Bearer test" },
        payload: { department_ids: ["A"] },
      });
      expect(response.statusCode).toBe(403);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
