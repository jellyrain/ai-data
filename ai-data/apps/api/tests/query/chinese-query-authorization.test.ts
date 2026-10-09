import { describe, expect, it, vi } from "vitest";
import {
  apiDatasetConfigSchema,
  datasetSchema,
  type ColumnPermission,
  type RowPolicy,
  type TablePermission,
} from "@ai-data/contracts";
import type { JwtService } from "../../src/auth/jwt-service";
import type { AuthContext } from "../../src/auth/auth-types";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";

const context: AuthContext = {
  userId: "u",
  organizationId: "org",
  sessionId: "s",
  roles: ["analyst"],
  roleIds: ["role"],
  permissions: [],
  dataPolicies: [],
};
describe.each([
  { scope: "科室名称", masked: "联系电话", denied: "诊断" },
  { scope: "__$operation", masked: "字段$名称", denied: "__$update_mask" },
])("中文和美元符号字段查询授权：$scope", (fields) => {
  const objectId = "view.业务.门诊明细";
  const query = {
    type: "relational_query",
    source_id: "业务库",
    from: { object_id: objectId, alias: "门诊" },
    select: [{ field: `门诊.${fields.masked}`, as: fields.masked }],
  };

  function setup() {
    const dataset = datasetSchema.parse({
      source_id: "业务库",
      object_id: objectId,
      name: "门诊明细",
      kind: "view",
      columns: [
        { name: fields.scope, data_type: "string", nullable: false },
        { name: fields.masked, data_type: "string", nullable: false },
        { name: fields.denied, data_type: "string", nullable: false },
      ],
    });
    const config = apiDatasetConfigSchema.parse({
      source_id: "业务库",
      object_id: objectId,
      column_policies: [
        {
          field: fields.masked,
          default_masking: { type: "partial_mask", prefix_length: 3, suffix_length: 4 },
        },
      ],
    });
    const policies = {
      tables: [{ role_id: "role", object_id: objectId, effect: "allow" }] as TablePermission[],
      rows: [
        {
          role_id: "role",
          object_id: objectId,
          effect: "allow",
          condition: { field: fields.scope, op: "eq", value: "内科" },
        },
      ] as RowPolicy[],
      columns: [
        { role_id: "role", object_id: objectId, column: fields.denied, effect: "deny" },
      ] as ColumnPermission[],
    };
    const catalog = new BusinessCatalogService(
      { listRawCatalog: async () => [dataset] },
      { find: async () => config, listBySourceId: async () => [config], save: async () => {} },
      {
        listObjectPermissions: async () => policies.tables,
        listColumnPermissions: async () => policies.columns,
        listRowPolicies: async () => policies.rows,
        saveObjectPermission: async () => {},
        saveColumnPermission: async () => {},
        saveRowPolicy: async () => {},
      },
    );
    const jwt = {
      signInternalQueryToken: vi.fn(async () => "token"),
      signQueryRequest: vi.fn(() => "signature"),
    };
    return {
      policies,
      jwt,
      service: new QueryAuthorizationService(catalog, jwt as unknown as JwtService),
    };
  }

  it("中文视图与结果列通过授权，行范围及脱敏仍按原字段生效", async () => {
    const { service } = setup();
    const { request } = await service.authorize(query, context);
    expect(request.query).toMatchObject({
      from: {
        object_id: objectId,
        filters: {
          logic: "or",
          items: [{ field: `门诊.${fields.scope}`, op: "eq", data_type: "string", value: "内科" }],
        },
      },
    });
    expect(request.access.output_masks).toEqual([
      {
        result_column: fields.masked,
        rule: { type: "partial_mask", prefix_length: 3, suffix_length: 4, mask_character: "*" },
      },
    ]);
  });
  it("中文禁用字段和对象仍拒绝查询且不会签名", async () => {
    const { service, policies, jwt } = setup();
    await expect(
      service.authorize({ ...query, select: [{ field: `门诊.${fields.denied}` }] }, context),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_COLUMN" });
    policies.tables[0].effect = "deny";
    await expect(service.authorize(query, context)).rejects.toMatchObject({
      code: "UNAUTHORIZED_OBJECT",
    });
    expect(jwt.signQueryRequest).not.toHaveBeenCalled();
  });
});
