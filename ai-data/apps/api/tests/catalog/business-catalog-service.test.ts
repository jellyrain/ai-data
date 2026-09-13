import { describe, expect, it } from "vitest";

import type { AuthContext } from "../../src/auth/auth-types";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import type {
  ApiDatasetConfigRepository,
  CatalogPermissionRepository,
  RawCatalogReader,
} from "../../src/catalog/catalog-types";

const clinicianContext: AuthContext = {
  userId: "user-clinician",
  organizationId: "hospital-a",
  sessionId: "session-clinician",
  roles: ["clinician"],
  roleIds: ["role-clinician"],
  permissions: [],
  dataPolicies: [],
};

const rawCatalog: RawCatalogReader = {
  listRawCatalog: async () => [
    {
      source_id: "clinical",
      object_id: "visit",
      name: "visit",
      kind: "table",
      columns: [
        { name: "patient_name", data_type: "string", nullable: false },
        { name: "department", data_type: "string", nullable: false },
      ],
      query_parameters: [],
    },
  ],
};

/** 固定目录配置与角色权限，姓名列拒绝访问，科室行策略供查询阶段使用。 */
class MemoryCatalogRepository implements ApiDatasetConfigRepository, CatalogPermissionRepository {
  async save() {}
  async find() {
    return null;
  }
  async listBySourceId() {
    return [
      {
        source_id: "clinical",
        object_id: "visit",
        business_description: "门诊就诊记录",
        column_descriptions: [{ field: "department", business_description: "就诊科室" }],
        approved_relations: [],
        column_policies: [],
      },
    ];
  }
  async saveObjectPermission() {}
  async saveColumnPermission() {}
  async saveRowPolicy() {}
  async listObjectPermissions() {
    return [{ role_id: "role-clinician", object_id: "visit", effect: "allow" as const }];
  }
  async listColumnPermissions() {
    return [
      {
        role_id: "role-clinician",
        object_id: "visit",
        column: "patient_name",
        effect: "deny" as const,
      },
    ];
  }
  async listRowPolicies() {
    return [
      {
        role_id: "role-clinician",
        object_id: "visit",
        effect: "allow" as const,
        condition: { field: "department", op: "eq" as const, value: "产科" },
      },
    ];
  }
}

describe("业务目录服务", () => {
  it("合并业务说明并按角色过滤对象和字段", async () => {
    const service = new BusinessCatalogService(
      rawCatalog,
      new MemoryCatalogRepository(),
      new MemoryCatalogRepository(),
    );

    const items = await service.listAuthorized(clinicianContext, "clinical");

    expect(items).toHaveLength(1);
    expect(items[0].dataset.source_description).toBe("门诊就诊记录");
    expect(items[0].dataset.columns).toEqual([
      { name: "department", data_type: "string", nullable: false, source_description: "就诊科室" },
    ]);
    expect(items[0].rowPolicies).toHaveLength(1);
    expect(items[0].rawColumns).toEqual([
      { name: "patient_name", data_type: "string", nullable: false },
      { name: "department", data_type: "string", nullable: false },
    ]);
  });

  it("仅在授权目录中搜索业务说明", async () => {
    const repository = new MemoryCatalogRepository();
    const service = new BusinessCatalogService(rawCatalog, repository, repository);

    const items = await service.searchAuthorized(clinicianContext, "clinical", "就诊", 20);

    expect(items.map((item) => item.dataset.object_id)).toEqual(["visit"]);
  });
});
