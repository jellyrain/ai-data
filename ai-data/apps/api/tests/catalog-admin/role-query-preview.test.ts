import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { apiDatasetConfigSchema, queryDslSchema } from "@ai-data/contracts";
import type { CatalogAdminRepository } from "../../src/catalog-admin/catalog-admin-types";
import { CatalogAdminService } from "../../src/catalog-admin/catalog-admin-service";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { JwtService } from "../../src/auth/jwt-service";
import { config, context } from "../support/api-fixtures";

let jwt: JwtService;
beforeAll(async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  jwt = await JwtService.create({
    ...config,
    jwt: {
      ...config.jwt,
      signing_private_key_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      verification_public_key_pem: pair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  });
});

/** 两个角色共享目录，产科角色的行范围与电话脱敏由真实授权转换器生成。 */
function setup() {
  const businessConfig = apiDatasetConfigSchema.parse({
    source_id: "clinical",
    object_id: "visit",
    column_policies: [
      {
        field: "phone",
        default_masking: {
          type: "partial_mask",
          prefix_length: 3,
          suffix_length: 4,
          mask_character: "*",
        },
        unmasked_role_ids: ["admin"],
      },
    ],
  });
  const catalog = new BusinessCatalogService(
    {
      listRawCatalog: async () => [
        {
          source_id: "clinical",
          object_id: "visit",
          name: "就诊",
          kind: "table",
          query_parameters: [],
          columns: ["phone", "department", "secret"].map((name) => ({
            name,
            data_type: "string" as const,
            nullable: false,
          })),
        },
      ],
    },
    {
      save: async () => {},
      listBySourceId: async () => [businessConfig],
      find: async () => businessConfig,
    },
    {
      saveObjectPermission: async () => {},
      saveColumnPermission: async () => {},
      saveRowPolicy: async () => {},
      listObjectPermissions: async () => [
        { role_id: "role-a", object_id: "visit", effect: "allow" },
      ],
      listColumnPermissions: async () => [
        { role_id: "role-a", object_id: "visit", column: "secret", effect: "deny" },
      ],
      listRowPolicies: async () => [],
    },
  );
  const repository: CatalogAdminRepository = {
    currentState: async () => ({
      version: 0,
      snapshot: { object_permissions: [], column_permissions: [], row_policies: [] },
    }),
    loadRoleAuthorization: async (_org, roleId) => ({
      roles: ["clinician"],
      roleIds: [roleId],
      permissions: [],
      permissionContext: { department_ids: [] },
      dataPolicies: [
        { resource: "visit", field: "department", operator: "eq", value: "产科", mandatory: true },
      ],
    }),
    saveChange: async () => {
      throw new Error("此场景只读取策略");
    },
    listVersions: async () => [],
    getVersion: async () => null,
  };
  return new CatalogAdminService({
    repository,
    catalog,
    authorization: new QueryAuthorizationService(catalog, jwt),
  });
}

describe("指定角色查询预览的真实授权转换", () => {
  it("管理员预览产科角色时得到角色行条件和结果列脱敏", async () => {
    const service = setup();
    const token = vi.spyOn(jwt, "signInternalQueryToken");
    const signature = vi.spyOn(jwt, "signQueryRequest");
    const query = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visit", alias: "v" },
      select: [{ field: "v.phone", as: "patient_phone" }],
    });
    const result = await service.previewQuery(context, "role-a", query);
    expect(result.query.from).toMatchObject({
      filters: {
        logic: "and",
        items: [{ field: "v.department", op: "eq", data_type: "string", value: "产科" }],
      },
    });
    expect(result.output_masks).toEqual([
      {
        result_column: "patient_phone",
        rule: { type: "partial_mask", prefix_length: 3, suffix_length: 4, mask_character: "*" },
      },
    ]);
    expect(Object.keys(result).sort()).toEqual(["output_masks", "query", "role_id"]);
    expect(token).not.toHaveBeenCalled();
    expect(signature).not.toHaveBeenCalled();
    token.mockRestore();
    signature.mockRestore();
  });

  it("目标角色禁止字段即使由管理员发起预览也被拒绝", async () => {
    const service = setup();
    const query = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visit", alias: "v" },
      select: [{ field: "v.secret" }],
    });
    await expect(service.previewQuery(context, "role-a", query)).rejects.toMatchObject({
      code: "UNAUTHORIZED_COLUMN",
    });
  });
});
