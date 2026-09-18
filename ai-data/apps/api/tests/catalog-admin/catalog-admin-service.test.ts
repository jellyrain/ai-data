import { describe, expect, it, vi } from "vitest";
import { queryDslSchema } from "@ai-data/contracts";

import { CatalogAdminService } from "../../src/catalog-admin/catalog-admin-service";
import type {
  CatalogAdminDependencies,
  CatalogAdminRepository,
} from "../../src/catalog-admin/catalog-admin-types";
import type { AuthContext } from "../../src/auth/auth-types";

const admin: AuthContext = {
  userId: "admin",
  organizationId: "hospital-a",
  sessionId: "session",
  roles: [],
  permissions: ["catalog:manage"],
  dataPolicies: [],
};
const permission = { role_id: "role-a", object_id: "visit", effect: "allow" as const };
const query = queryDslSchema.parse({
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visit", alias: "v" },
  select: [{ field: "v.department" }],
  limit: 10,
});

/** 管理员与目标角色具有不同的范围，场景验证指定角色身份的独立构造。 */
function setup() {
  const role = {
    roles: ["clinician"],
    roleIds: ["role-a"],
    permissions: ["query:read"],
    dataPolicies: [
      {
        resource: "visit",
        field: "department",
        operator: "eq" as const,
        value: "产科",
        mandatory: true as const,
      },
    ],
    permissionContext: { department_ids: [] },
  };
  const repository = {
    loadRoleAuthorization: vi.fn<CatalogAdminRepository["loadRoleAuthorization"]>(async () => role),
    saveChange: vi.fn<CatalogAdminRepository["saveChange"]>(async (actor, sourceId, change) => ({
      organization_id: actor.organizationId,
      source_id: sourceId,
      role_id: change.permission.role_id,
      version: 1,
      changed_by: actor.userId,
      changed_at: "2026-09-14 10:00:00",
      summary: {
        kind: change.kind,
        object_id: change.permission.object_id,
        effect: change.permission.effect,
      },
      change,
      snapshot: { object_permissions: [permission], column_permissions: [], row_policies: [] },
    })),
    listVersions: vi.fn(async () => []),
    getVersion: vi.fn(async () => null),
  };
  const catalog = {
    getAuthorized: vi.fn<CatalogAdminDependencies["catalog"]["getAuthorized"]>(async () => ({
      dataset: {
        source_id: "clinical",
        object_id: "visit",
        name: "visit",
        kind: "table" as const,
        columns: [{ name: "department", data_type: "string" as const, nullable: false }],
        query_parameters: [],
      },
      rawColumns: [{ name: "department", data_type: "string" as const, nullable: false }],
      rowPolicies: [],
      allowedRoleIds: [],
    })),
  };
  const authorization = { preview: vi.fn(async () => ({ query, outputMasks: [] })) };
  const service = new CatalogAdminService({
    repository,
    catalog,
    authorization,
  });
  return { service, repository, catalog, authorization, role };
}

// 前提：管理者属于医院甲。操作：维护目录策略或预览指定角色。预期：角色、源、字段均通过校验后才保存或授权。
describe("目录权限管理", () => {
  it("具备目录管理权限时保存当前组织的策略变更及预期版本", async () => {
    const { service, repository, catalog } = setup();
    await expect(
      service.saveObjectPermission(admin, "clinical", permission, 0),
    ).resolves.toMatchObject({
      version: 1,
    });
    expect(repository.loadRoleAuthorization).toHaveBeenCalledWith("hospital-a", "role-a");
    expect(catalog.getAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ["system_admin"] }),
      "clinical",
      "visit",
    );
    expect(repository.saveChange).toHaveBeenCalledWith(
      admin,
      "clinical",
      { kind: "object_permission", permission },
      0,
    );
  });

  it("普通角色不能修改策略且仓储未被调用", async () => {
    const { service, repository } = setup();
    await expect(
      service.saveObjectPermission({ ...admin, permissions: [] }, "clinical", permission),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(repository.loadRoleAuthorization).not.toHaveBeenCalled();
    expect(repository.saveChange).not.toHaveBeenCalled();
  });

  it("目标角色不属于当前组织时拒绝保存", async () => {
    const { service, repository, catalog } = setup();
    repository.loadRoleAuthorization.mockResolvedValue(null);
    await expect(service.saveObjectPermission(admin, "clinical", permission)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(repository.saveChange).not.toHaveBeenCalled();
    expect(catalog.getAuthorized).not.toHaveBeenCalled();
  });

  it("对象不存在时拒绝保存", async () => {
    const { service, repository, catalog } = setup();
    catalog.getAuthorized.mockResolvedValue(null);
    await expect(service.saveObjectPermission(admin, "clinical", permission)).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );
    expect(repository.saveChange).not.toHaveBeenCalled();
  });

  it("字段权限引用不存在的列时拒绝保存", async () => {
    const { service, repository } = setup();
    await expect(
      service.saveColumnPermission(admin, "clinical", { ...permission, column: "missing" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repository.saveChange).not.toHaveBeenCalled();
  });

  it("行策略引用不存在的列时拒绝保存", async () => {
    const { service, repository } = setup();
    await expect(
      service.saveRowPolicy(admin, "clinical", {
        ...permission,
        condition: { field: "missing", op: "eq", value: "产科" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repository.saveChange).not.toHaveBeenCalled();
  });

  it("数据源不可用时沿用目录失败并保持策略不变", async () => {
    const { service, repository, catalog } = setup();
    const failure = Object.assign(new Error("数据源不可用"), { code: "DATA_SOURCE_UNAVAILABLE" });
    catalog.getAuthorized.mockRejectedValue(failure);
    await expect(service.saveObjectPermission(admin, "clinical", permission)).rejects.toBe(failure);
    expect(repository.saveChange).not.toHaveBeenCalled();
  });

  it("预览使用目标角色的功能权限和行范围", async () => {
    const { service, authorization, role } = setup();
    const result = await service.previewQuery(
      {
        ...admin,
        roles: ["system_admin"],
        dataPolicies: [
          {
            resource: "visit",
            field: "department",
            operator: "eq",
            value: "管理科",
            mandatory: true,
          },
        ],
        permissionContext: { department_ids: ["admin-department"] },
      },
      "role-a",
      query,
    );
    expect(authorization.preview).toHaveBeenCalledWith(query, {
      userId: "admin",
      organizationId: "hospital-a",
      sessionId: "session",
      ...role,
    });
    expect(result).toEqual({ role_id: "role-a", query, output_masks: [] });
  });

  it("预览保留查询授权的拒绝原因", async () => {
    const { service, authorization } = setup();
    const denied = Object.assign(new Error("字段无权访问"), { code: "UNAUTHORIZED_COLUMN" });
    authorization.preview.mockRejectedValue(denied);
    await expect(service.previewQuery(admin, "role-a", query)).rejects.toBe(denied);
  });

  it("依赖个人用户标识的行策略要求按用户查询，纯角色预览拒绝代入管理员", async () => {
    const { service, authorization, catalog } = setup();
    const object = (await catalog.getAuthorized(admin, "clinical", "visit"))!;
    catalog.getAuthorized.mockResolvedValue({
      ...object,
      rowPolicies: [
        {
          ...permission,
          condition: { field: "department", op: "eq", value_from: "permission_context.user_id" },
        },
      ],
    });
    await expect(service.previewQuery(admin, "role-a", query)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
    expect(authorization.preview).not.toHaveBeenCalled();
  });

  it("读取版本前校验组织并限制返回条数", async () => {
    const { service, repository } = setup();
    await service.listVersions(admin, "clinical", "role-a", 20, 5);
    expect(repository.listVersions).toHaveBeenCalledWith("hospital-a", "clinical", "role-a", 20, 5);
    repository.loadRoleAuthorization.mockResolvedValue(null);
    await expect(service.getVersion(admin, "clinical", "foreign-role", 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(repository.getVersion).not.toHaveBeenCalled();
  });
});
