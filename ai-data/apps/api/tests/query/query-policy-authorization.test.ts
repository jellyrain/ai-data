import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  filterGroupSchema,
  stableStringify,
  type ApiDatasetConfig,
  type ColumnPermission,
  type Dataset,
  type RowPolicy,
  type TablePermission,
} from "@ai-data/contracts";

import type { AuthContext } from "../../src/auth/auth-types";
import { JwtService } from "../../src/auth/jwt-service";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { config } from "../support/api-fixtures";

const context: AuthContext = {
  userId: "user-a",
  organizationId: "org-a",
  sessionId: "session-a",
  roles: ["clinician"],
  roleIds: ["role-a"],
  permissions: [],
  dataPolicies: [],
};

const columns: Dataset["columns"] = [
  { name: "id", data_type: "integer", nullable: false },
  { name: "parent_id", data_type: "integer", nullable: false },
  { name: "alternate_id", data_type: "integer", nullable: false },
  { name: "org", data_type: "string", nullable: false },
  { name: "dept", data_type: "string", nullable: true },
];
const datasets: Dataset[] = ["visit", "detail", "staff"].map((object_id) => ({
  source_id: "clinical",
  object_id,
  name: object_id,
  kind: "table",
  columns,
  query_parameters: [],
}));
const baseQuery = {
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visit", alias: "v" },
  select: [{ field: "v.id" }],
};
const primaryPairs = [
  { source_column: "id", target_column: "parent_id" },
  { source_column: "org", target_column: "org" },
];
const alternatePairs = [
  { source_column: "alternate_id", target_column: "alternate_id" },
  { source_column: "org", target_column: "org" },
];
const join = {
  type: "left",
  object_id: "detail",
  alias: "d",
  on: [
    { left: "v.id", op: "eq", right: "d.parent_id" },
    { left: "v.org", op: "eq", right: "d.org" },
  ],
};
let jwt: JwtService;
let verificationKey: KeyObject;
beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  verificationKey = publicKey;
  jwt = await JwtService.create({
    ...config,
    jwt: {
      ...config.jwt,
      signing_private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      verification_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  });
});

function policy(
  condition: RowPolicy["condition"],
  object_id = "visit",
  role_id = "role-a",
): RowPolicy {
  return { role_id, object_id, effect: "allow", condition };
}

function setup(
  rowPolicies: RowPolicy[] = [],
  objectPermissions?: TablePermission[],
  columnPermissions: ColumnPermission[] = [],
) {
  const configs: ApiDatasetConfig[] = datasets.map((dataset) => ({
    source_id: "clinical",
    object_id: dataset.object_id,
    column_descriptions: [],
    column_policies: [],
    approved_relations: datasets
      .map((target) => ({
        target_object_id: target.object_id,
        description: "主键与机构",
        column_pairs: primaryPairs,
      }))
      .concat([
        {
          target_object_id: "detail",
          description: "业务备用键与机构",
          column_pairs: alternatePairs,
        },
      ]),
  }));
  const repository = {
    find: async (_source: string, objectId: string) =>
      configs.find((item) => item.object_id === objectId) ?? null,
    listBySourceId: async () => configs,
    save: async () => {},
    saveObjectPermission: async () => {},
    saveColumnPermission: async () => {},
    saveRowPolicy: async () => {},
    listObjectPermissions: async () =>
      objectPermissions ??
      datasets.map((dataset) => ({
        role_id: "role-a",
        object_id: dataset.object_id,
        effect: "allow" as const,
      })),
    listColumnPermissions: async () => columnPermissions,
    listRowPolicies: async () => rowPolicies,
  };
  const catalog = new BusinessCatalogService(
    { listRawCatalog: async () => datasets },
    repository,
    repository,
  );
  return { service: new QueryAuthorizationService(catalog, jwt), catalog };
}

async function authorize(
  rowPolicies: RowPolicy[],
  input: unknown = baseQuery,
  identity: AuthContext = context,
) {
  const { service } = setup(rowPolicies);
  const result = await service.authorize(input, identity);
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(stableStringify({ access: result.request.access, query: result.request.query })),
      verificationKey,
      Buffer.from(result.request.signature, "base64url"),
    ),
  ).toBe(true);
  if (result.request.query.type !== "relational_query") throw new Error("预期关系查询");
  return result.request.query;
}

describe("关系查询的对象行授权", () => {
  it("带值 ON 保留匹配条件并纳入请求签名", async () => {
    const on_filters = {
      logic: "or",
      items: [
        { field: "v.dept", op: "eq", data_type: "string", value: "A" },
        { field: "d.dept", op: "eq", data_type: "string", value: "B" },
      ],
    };
    expect(await authorize([], { ...baseQuery, joins: [{ ...join, on_filters }] })).toMatchObject({
      joins: [{ on_filters }],
    });
  });
  it.each(["future.dept", "d.missing"])("带值 ON 拒绝不可访问字段 %s", async (field) => {
    await expect(
      authorize([], {
        ...baseQuery,
        joins: [
          {
            ...join,
            on_filters: {
              logic: "and",
              items: [{ field, op: "eq", data_type: "string", value: "A" }],
            },
          },
        ],
      }),
    ).rejects.toThrow();
  });
  it.each<RowPolicy["condition"]>([
    { field: "dept", op: "eq", value: "A" },
    { field: "dept", op: "neq", value: "A" },
    { field: "dept", op: "in", value: ["A", "B"] },
    { field: "dept", op: "not_in", value: ["A", "B"] },
    { field: "id", op: "between", value: [1, 3] },
    { field: "dept", op: "is_null" },
    { field: "dept", op: "not_null" },
  ])("将 $op 策略求值到主对象过滤", async (condition) => {
    const query = await authorize([policy(condition)]);
    expect(query.from).toMatchObject({
      filters: {
        logic: "or",
        items: [
          {
            ...condition,
            field: `v.${condition.field}`,
            data_type: condition.field === "id" ? "integer" : "string",
          },
        ],
      },
    });
    expect(query.filters).toEqual({ logic: "and", items: [] });
  });

  it("同一角色的多条允许范围以 OR 合并", async () => {
    const query = await authorize([
      policy({ field: "dept", op: "eq", value: "A" }),
      policy({ field: "dept", op: "eq", value: "B" }),
    ]);
    expect(query.from).toMatchObject({
      filters: {
        logic: "or",
        items: [expect.objectContaining({ value: "A" }), expect.objectContaining({ value: "B" })],
      },
    });
  });

  it("多个获准角色的行范围取并集", async () => {
    const permissions: TablePermission[] = ["role-a", "role-b"].map((role_id) => ({
      role_id,
      object_id: "visit",
      effect: "allow",
    }));
    const { service } = setup(
      [
        policy({ field: "dept", op: "eq", value: "A" }),
        policy({ field: "dept", op: "eq", value: "B" }, "visit", "role-b"),
      ],
      permissions,
    );
    const { request } = await service.authorize(baseQuery, {
      ...context,
      roleIds: ["role-a", "role-b"],
    });
    expect(request.query.from).toMatchObject({
      filters: {
        logic: "or",
        items: [expect.objectContaining({ value: "A" }), expect.objectContaining({ value: "B" })],
      },
    });
  });

  it("没有行限制的获准角色提供完整对象范围，强制身份范围仍生效", async () => {
    const permissions: TablePermission[] = ["role-a", "role-b"].map((role_id) => ({
      role_id,
      object_id: "visit",
      effect: "allow",
    }));
    const { service } = setup([policy({ field: "dept", op: "eq", value: "A" })], permissions);
    const { request } = await service.authorize(baseQuery, {
      ...context,
      roleIds: ["role-a", "role-b"],
      dataPolicies: [
        { resource: "visit", field: "org", operator: "eq", value: "org-a", mandatory: true },
      ],
    });
    expect(request.query.from).toMatchObject({
      filters: {
        logic: "and",
        items: [{ field: "v.org", op: "eq", value: "org-a", data_type: "string" }],
      },
    });
  });

  it("角色范围与多条强制身份条件按 AND 组合", async () => {
    const query = await authorize([policy({ field: "dept", op: "eq", value: "A" })], baseQuery, {
      ...context,
      dataPolicies: [
        { resource: "visit", field: "org", operator: "eq", value: "org-a", mandatory: true },
        { resource: "visit", field: "dept", operator: "in", value: ["A", "B"], mandatory: true },
      ],
    });
    expect(query.from).toMatchObject({
      filters: {
        logic: "and",
        items: [
          expect.objectContaining({ logic: "or" }),
          expect.objectContaining({ field: "v.org" }),
          expect.objectContaining({ field: "v.dept", op: "in" }),
        ],
      },
    });
  });

  it.each(["left", "right", "inner"])(
    "%s 关联的各对象独立预过滤，用户查询级条件保留",
    async (type) => {
      const filters = {
        logic: "or",
        items: [{ field: "d.dept", op: "is_null", data_type: "string" }],
      };
      const query = await authorize(
        [
          policy({ field: "org", op: "eq", value: "org-a" }),
          policy({ field: "dept", op: "eq", value: "A" }, "detail"),
        ],
        { ...baseQuery, joins: [{ ...join, type }], filters },
      );
      expect(query.from).toMatchObject({
        filters: { items: [expect.objectContaining({ field: "v.org" })] },
      });
      expect(query.joins[0]).toMatchObject({
        filters: { items: [expect.objectContaining({ field: "d.dept" })] },
      });
      expect(query.filters).toEqual(filters);
    },
  );

  it("同一对象多别名逐一施加角色与身份范围", async () => {
    const query = await authorize(
      [policy({ field: "dept", op: "eq", value: "A" })],
      { ...baseQuery, joins: [{ ...join, object_id: "visit" }] },
      {
        ...context,
        dataPolicies: [
          { resource: "visit", field: "org", operator: "eq", value: "org-a", mandatory: true },
        ],
      },
    );
    expect(JSON.stringify(query.from)).toContain('"v.dept"');
    expect(JSON.stringify(query.from)).toContain('"v.org"');
    expect(JSON.stringify(query.joins[0])).toContain('"d.dept"');
    expect(JSON.stringify(query.joins[0])).toContain('"d.org"');
  });

  it("用户对象过滤与权限相交", async () => {
    const inputFilters = {
      logic: "or",
      items: [{ field: "v.dept", op: "eq", value: "B", data_type: "string" }],
    };
    const query = await authorize([policy({ field: "dept", op: "eq", value: "A" })], {
      ...baseQuery,
      from: { ...baseQuery.from, filters: inputFilters },
    });
    expect(query.from).toMatchObject({
      filters: { logic: "and", items: [inputFilters, expect.objectContaining({ logic: "or" })] },
    });
  });

  it.each(["from", "join"])("拒绝 %s 对象过滤树中的其他对象引用", async (side) => {
    const foreignFilter = {
      logic: "and",
      items: [
        {
          logic: "or",
          items: [
            {
              field: side === "from" ? "d.dept" : "v.dept",
              op: "eq",
              data_type: "string",
              value: "A",
            },
          ],
        },
      ],
    };
    const { service } = setup();
    await expect(
      service.authorize(
        {
          ...baseQuery,
          from: { ...baseQuery.from, ...(side === "from" ? { filters: foreignFilter } : {}) },
          joins: [{ ...join, ...(side === "join" ? { filters: foreignFilter } : {}) }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_COLUMN" });
  });

  it.each<RowPolicy["condition"]>([
    { field: "dept", op: "in", value: [] },
    { field: "dept", op: "eq", value: ["A"] },
    { field: "id", op: "eq", value: "invalid" },
    { field: "id", op: "between", value: [1] },
    { field: "dept", op: "eq", value_from: "permission_context.missing" },
    { field: "dept", op: "eq" },
    { field: "dept", op: "not_null", value: "A" },
    { field: "missing", op: "eq", value: "A" },
  ])("拒绝无法求值的 $op 策略：$field", async (condition) => {
    const { service } = setup([policy(condition)]);
    const sign = vi.spyOn(jwt, "signQueryRequest");
    const count = sign.mock.calls.length;
    await expect(service.authorize(baseQuery, context)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
    expect(sign.mock.calls).toHaveLength(count);
  });

  it("非当前身份角色的策略不能扩大对象范围", async () => {
    const query = await authorize([
      policy({ field: "dept", op: "eq", value: "A" }),
      policy({ field: "dept", op: "eq", value: "B" }, "visit", "outsider"),
    ]);
    expect(query.from).toMatchObject({
      filters: { logic: "or", items: [expect.objectContaining({ value: "A" })] },
    });
  });

  it("已绑定但未获准对象的角色不能增加允许范围", async () => {
    const query = await authorize(
      [
        policy({ field: "dept", op: "eq", value: "A" }),
        policy({ field: "dept", op: "eq", value: "B" }, "visit", "role-b"),
      ],
      baseQuery,
      { ...context, roleIds: ["role-a", "role-b"] },
    );
    expect(query.from).toMatchObject({
      filters: { logic: "or", items: [expect.objectContaining({ value: "A" })] },
    });
  });

  it("没有行限制的角色与另一个角色的非法策略同时存在时拒绝签发", async () => {
    const permissions: TablePermission[] = ["role-a", "role-b"].map((role_id) => ({
      role_id,
      object_id: "visit",
      effect: "allow",
    }));
    const { service } = setup([policy({ field: "dept", op: "in", value: [] })], permissions);
    await expect(
      service.authorize(baseQuery, { ...context, roleIds: ["role-a", "role-b"] }),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("对象显式拒绝优先于允许角色", async () => {
    const { service } = setup(
      [],
      [
        { role_id: "role-a", object_id: "visit", effect: "allow" },
        { role_id: "role-b", object_id: "visit", effect: "deny" },
      ],
    );
    await expect(
      service.authorize(baseQuery, { ...context, roleIds: ["role-a", "role-b"] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_OBJECT" });
  });

  it("属于其他资源的强制范围独立于当前对象", async () => {
    const query = await authorize([], baseQuery, {
      ...context,
      dataPolicies: [
        { resource: "staff", field: "missing", operator: "eq", value: "A", mandatory: true },
      ],
    });
    expect(query.from).toEqual(baseQuery.from);
    expect(query.filters).toEqual({ logic: "and", items: [] });
  });

  it.each([
    { field: "missing", operator: "eq" as const, value: "A" },
    { field: "id", operator: "eq" as const, value: "A" },
    { field: "dept", operator: "in" as const, value: [] },
  ])("拒绝已匹配对象上不可表达的强制范围 $field", async (restriction) => {
    const { service } = setup();
    await expect(
      service.authorize(baseQuery, {
        ...context,
        dataPolicies: [{ ...restriction, resource: "visit", mandatory: true }],
      }),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("权限条件引用被隐藏的列时明确拒绝", async () => {
    const { service } = setup([policy({ field: "dept", op: "eq", value: "A" })], undefined, [
      { role_id: "role-a", object_id: "visit", column: "dept", effect: "deny" },
    ]);
    await expect(service.authorize(baseQuery, context)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it.each([
    { path: "user_id", field: "dept", value: context.userId, op: "eq" as const },
    { path: "organization_id", field: "org", value: context.organizationId, op: "neq" as const },
    { path: "department_ids", field: "dept", value: ["A", "B"], op: "in" as const },
    { path: "department_ids", field: "dept", value: ["A", "B"], op: "not_in" as const },
  ])("从可信权限上下文求值 $path 的 $op 条件", async ({ path, field, value, op }) => {
    const query = await authorize(
      [policy({ field, op, value_from: `permission_context.${path}` })],
      baseQuery,
      { ...context, permissionContext: { department_ids: ["A", "B"] } },
    );
    expect(query.from).toMatchObject({
      filters: { items: [{ field: `v.${field}`, op, data_type: "string", value }] },
    });
    expect(JSON.stringify(query)).not.toContain("value_from");
  });

  it("部门上下文缺失时拒绝签发", async () => {
    const { service } = setup([
      policy({ field: "dept", op: "in", value_from: "permission_context.department_ids" }),
    ]);
    await expect(service.authorize(baseQuery, context)).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
  });

  it("部门上下文为空时拒绝签发", async () => {
    const { service } = setup([
      policy({ field: "dept", op: "in", value_from: "permission_context.department_ids" }),
    ]);
    await expect(
      service.authorize(baseQuery, { ...context, permissionContext: { department_ids: [] } }),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });
});

describe("批准组合关系授权", () => {
  it.each([
    [join.on[0]],
    [...join.on, join.on[0]],
    [...join.on, { left: "v.dept", op: "eq", right: "d.dept" }],
    [join.on[0], { left: "v.alternate_id", op: "eq", right: "d.alternate_id" }],
    [{ left: "d.parent_id", op: "eq", right: "d.parent_id" }],
  ])("拒绝未完整匹配某一批准关系的条件 %j", async (...on) => {
    const { service } = setup();
    await expect(
      service.authorize({ ...baseQuery, joins: [{ ...join, on }] }, context),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_OBJECT" });
  });

  it("可以完整选择第二条批准关系且字段对顺序不影响匹配", async () => {
    const query = await authorize([], {
      ...baseQuery,
      joins: [
        {
          ...join,
          on: [
            { left: "v.org", op: "eq", right: "d.org" },
            { left: "v.alternate_id", op: "eq", right: "d.alternate_id" },
          ],
        },
      ],
    });
    expect(query.joins).toHaveLength(1);
  });

  it("第二个 Join 可以关联真实已存在的主对象别名", async () => {
    const query = await authorize([], {
      ...baseQuery,
      joins: [
        join,
        {
          ...join,
          object_id: "staff",
          alias: "s",
          on: [
            { left: "v.id", op: "eq", right: "s.parent_id" },
            { left: "v.org", op: "eq", right: "s.org" },
          ],
        },
      ],
    });
    expect(query.joins).toHaveLength(2);
  });

  it("拒绝引用尚未加入的别名", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        {
          ...baseQuery,
          joins: [
            {
              ...join,
              on: [
                { left: "s.id", op: "eq", right: "d.parent_id" },
                { left: "s.org", op: "eq", right: "d.org" },
              ],
            },
            { ...join, alias: "s" },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_OBJECT" });
  });

  it("链式外连接的每个参与对象保留独立权限过滤", async () => {
    const query = await authorize(
      datasets.map((dataset) => policy({ field: "dept", op: "eq", value: "A" }, dataset.object_id)),
      {
        ...baseQuery,
        joins: [
          join,
          {
            ...join,
            type: "right",
            object_id: "staff",
            alias: "s",
            on: [
              { left: "d.id", op: "eq", right: "s.parent_id" },
              { left: "d.org", op: "eq", right: "s.org" },
            ],
          },
        ],
      },
    );
    expect(query.filters).toEqual({ logic: "and", items: [] });
    for (const ref of [query.from, ...query.joins]) {
      expect(ref).toMatchObject({
        filters: { items: [expect.objectContaining({ field: `${ref.alias}.dept` })] },
      });
      expect(filterGroupSchema.safeParse("filters" in ref ? ref.filters : undefined).success).toBe(
        true,
      );
    }
  });
});
