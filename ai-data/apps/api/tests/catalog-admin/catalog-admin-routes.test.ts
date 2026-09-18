import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { queryDslSchema } from "@ai-data/contracts";

import { registerCatalogAdminRoutes } from "../../src/routes/catalog-admin-routes";
import { registerCatalogRoutes } from "../../src/routes/catalog-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { createApiDependencies, context } from "../support/api-fixtures";
import type { CatalogAdminService } from "../../src/catalog-admin/catalog-admin-service";
import { policyVersionSchema } from "../../src/catalog-admin/catalog-admin-schemas";

const query = queryDslSchema.parse({
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visit", alias: "v" },
  select: [{ field: "v.department" }],
  limit: 10,
});
const savedVersion = policyVersionSchema.parse({
  organization_id: "org",
  source_id: "clinical",
  role_id: "role-a",
  version: 5,
  changed_by: "admin",
  changed_at: "2026-09-14 10:00:00",
  summary: { kind: "object_permission", object_id: "visit", effect: "allow" },
  change: {
    kind: "object_permission",
    permission: { role_id: "role-a", object_id: "visit", effect: "allow" },
  },
  snapshot: { object_permissions: [], column_permissions: [], row_policies: [] },
});

/** 路由替身返回固定版本，用来核对认证上下文、严格输入及版本传输。 */
function setup() {
  const dependencies = createApiDependencies();
  const service = {
    saveObjectPermission: vi.fn<CatalogAdminService["saveObjectPermission"]>(
      async () => savedVersion,
    ),
    saveColumnPermission: vi.fn<CatalogAdminService["saveColumnPermission"]>(
      async () => savedVersion,
    ),
    saveRowPolicy: vi.fn<CatalogAdminService["saveRowPolicy"]>(async () => savedVersion),
    listVersions: vi.fn<CatalogAdminService["listVersions"]>(async () => [savedVersion]),
    getVersion: vi.fn<CatalogAdminService["getVersion"]>(async () => savedVersion),
    previewQuery: vi.fn(async () => ({ role_id: "role-a", query, output_masks: [] })),
  };
  const app = Fastify();
  registerContractErrorHandler(app);
  registerCatalogRoutes(
    app,
    dependencies.auth,
    dependencies.catalog.service,
    dependencies.catalog.permissions,
    service,
  );
  registerCatalogAdminRoutes(app, dependencies.auth, service);
  return { app, service, dependencies };
}

// 前提：HTTP 中间件加载当前管理员身份。操作：写策略、读版本或预览角色。预期：只传递可信组织，原有 PUT 状态码和新的版本头均可读取。
describe("目录策略管理 HTTP 接口", () => {
  it("对象权限维护调用管理服务并返回已保存版本头", async () => {
    const { app, service, dependencies } = setup();
    const response = await app.inject({
      method: "PUT",
      url: "/admin/catalog/object-permissions",
      headers: { authorization: "Bearer test" },
      payload: {
        source_id: "clinical",
        role_id: "role-a",
        object_id: "visit",
        effect: "allow",
        expected_version: 3,
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["x-policy-version"]).toBe("5");
    expect(service.saveObjectPermission).toHaveBeenCalledWith(
      context,
      "clinical",
      { role_id: "role-a", object_id: "visit", effect: "allow" },
      3,
    );
    expect(dependencies.catalog.permissions.saveObjectPermission).not.toHaveBeenCalled();
    await app.close();
  });

  it("维护字段和行策略时将可信上下文传给管理服务", async () => {
    const { app, service } = setup();
    for (const [path, payload] of [
      ["column-permissions", { column: "department" }],
      ["row-policies", { condition: { field: "department", op: "eq", value: "产科" } }],
    ] as const) {
      const response = await app.inject({
        method: "PUT",
        url: `/admin/catalog/${path}`,
        headers: { authorization: "Bearer test" },
        payload: {
          source_id: "clinical",
          role_id: "role-a",
          object_id: "visit",
          effect: "allow",
          ...payload,
        },
      });
      expect(response.statusCode).toBe(204);
    }
    expect(service.saveColumnPermission).toHaveBeenCalledWith(
      context,
      "clinical",
      expect.objectContaining({ column: "department" }),
      undefined,
    );
    expect(service.saveRowPolicy).toHaveBeenCalledWith(
      context,
      "clinical",
      expect.objectContaining({ condition: { field: "department", op: "eq", value: "产科" } }),
      undefined,
    );
    await app.close();
  });

  it("版本清单和详情根据当前组织及路径角色查询", async () => {
    const { app, service } = setup();
    const headers = { authorization: "Bearer test" };
    expect(
      (
        await app.inject({
          url: "/admin/catalog/policy-versions/clinical/role-a?limit=10&before_version=8",
          headers,
        })
      ).json(),
    ).toMatchObject({ items: [{ version: 5 }] });
    expect(service.listVersions).toHaveBeenCalledWith(context, "clinical", "role-a", 10, 8);
    expect(
      (
        await app.inject({ url: "/admin/catalog/policy-versions/clinical/role-a/current", headers })
      ).json(),
    ).toMatchObject({ version: 5 });
    expect(service.getVersion).toHaveBeenLastCalledWith(context, "clinical", "role-a");
    expect(
      (await app.inject({ url: "/admin/catalog/policy-versions/clinical/role-a/3", headers }))
        .statusCode,
    ).toBe(200);
    expect(service.getVersion).toHaveBeenLastCalledWith(context, "clinical", "role-a", 3);
    service.getVersion.mockResolvedValue(null);
    expect(
      (await app.inject({ url: "/admin/catalog/policy-versions/clinical/role-a/9", headers }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });

  it("预览响应只包含目标角色、授权查询及脱敏规则", async () => {
    const { app, service } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/admin/catalog/query-preview",
      headers: { authorization: "Bearer test" },
      payload: { role_id: "role-a", query },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ role_id: "role-a", query, output_masks: [] });
    expect(service.previewQuery).toHaveBeenCalledWith(context, "role-a", query);
    await app.close();
  });

  it("伪造组织和越界分页被严格输入合同拒绝", async () => {
    const { app, service } = setup();
    const headers = { authorization: "Bearer test" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/catalog/query-preview",
          headers,
          payload: { role_id: "role-a", organization_id: "foreign", query },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: "/admin/catalog/policy-versions/clinical/role-a?limit=101",
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(service.previewQuery).not.toHaveBeenCalled();
    expect(service.listVersions).not.toHaveBeenCalled();
    await app.close();
  });
});
