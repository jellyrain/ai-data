import { describe, expect, it, vi } from "vitest";

import { apiDatasetConfigSchema, datasetSchema, type Dataset } from "@ai-data/contracts";

import type { AuthContext } from "../../src/auth/auth-types";
import type { JwtService } from "../../src/auth/jwt-service";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import type { CatalogPermissionRepository } from "../../src/catalog/catalog-types";
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
const columns: Dataset["columns"] = [
  { name: "id", data_type: "integer", nullable: false },
  { name: "visit_id", data_type: "integer", nullable: false },
  { name: "org", data_type: "string", nullable: false },
  { name: "amount", data_type: "decimal", nullable: false },
  { name: "name", data_type: "string", nullable: false },
];
const pairs = [
  { source_column: "id", target_column: "visit_id" },
  { source_column: "org", target_column: "org" },
];
const datasets = ["visit", "fee", "prescription"].map((object_id) =>
  datasetSchema.parse({
    source_id: "clinical",
    object_id,
    name: object_id,
    kind: "table",
    columns,
  }),
);

/** 以两类就诊明细与审核过的复合键验证统计查询；签名替身只记录成功签发的载荷。 */
function setup() {
  const rawDatasets = structuredClone(datasets);
  const configs = datasets.map((dataset) =>
    apiDatasetConfigSchema.parse({
      source_id: "clinical",
      object_id: dataset.object_id,
      unique_keys: [["id", "org"]],
      approved_relations:
        dataset.object_id === "visit"
          ? ["fee", "prescription"].map((target_object_id) => ({
              relation_id: target_object_id,
              target_object_id,
              description: "就诊明细",
              cardinality: "one_to_many",
              column_pairs: pairs,
            }))
          : [],
    }),
  );
  const permissions: CatalogPermissionRepository = {
    saveObjectPermission: async () => {},
    saveColumnPermission: async () => {},
    saveRowPolicy: async () => {},
    listObjectPermissions: async () =>
      datasets.map((item) => ({
        role_id: "role",
        object_id: item.object_id,
        effect: "allow" as const,
      })),
    listColumnPermissions: async () => [],
    listRowPolicies: async () => [],
  };
  const catalog = new BusinessCatalogService(
    { listRawCatalog: async () => rawDatasets },
    {
      find: async (_source, object) => configs.find((item) => item.object_id === object) ?? null,
      listBySourceId: async () => configs,
      save: async () => {},
    },
    permissions,
  );
  const jwt = {
    signInternalQueryToken: vi.fn(async () => "token"),
    signQueryRequest: vi.fn(() => "signature"),
  };
  return {
    service: new QueryAuthorizationService(catalog, jwt as unknown as JwtService),
    configs,
    permissions,
    jwt,
    rawDatasets,
  };
}

function detailJoin(object = "fee", alias = "f", preAggregate = false) {
  return {
    type: "left",
    object_id: object,
    alias,
    relation_id: object,
    on: [
      { left: "v.id", op: "eq", right: `${alias}.visit_id` },
      { left: "v.org", op: "eq", right: `${alias}.org` },
    ],
    ...(preAggregate
      ? {
          pre_aggregate: {
            group_by: [`${alias}.visit_id`, `${alias}.org`],
            select: [
              { field: `${alias}.visit_id`, as: "visit_id" },
              { field: `${alias}.org`, as: "org" },
              { field: `${alias}.amount`, aggregation: "sum", as: "total" },
            ],
          },
        }
      : {}),
  };
}
const base = {
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visit", alias: "v" },
  select: [{ field: "v.id" }],
};

describe("关联统计的粒度与基数授权", () => {
  it("多费用与多处方均按就诊机构预聚合后可汇总费用且权限在内层前执行", async () => {
    const { service } = setup();
    const input = {
      ...base,
      joins: [detailJoin("fee", "f", true), detailJoin("prescription", "p", true)],
      select: [{ field: "f.total", aggregation: "sum", as: "total_fee" }],
      order_by: [{ field: "total_fee", direction: "desc" }],
    };
    const { request } = await service.authorize(input, {
      ...context,
      dataPolicies: [
        { resource: "fee", field: "org", operator: "eq", value: "org", mandatory: true },
      ],
    });
    expect(request.query).toMatchObject({
      joins: [
        {
          filters: { items: [expect.objectContaining({ field: "f.org", value: "org" })] },
          pre_aggregate: detailJoin("fee", "f", true).pre_aggregate,
        },
        { pre_aggregate: detailJoin("prescription", "p", true).pre_aggregate },
      ],
    });
  });

  it.each(["sum", "count", "avg"])(
    "原始多费用与多处方关联使 %s 重复时拒绝签发",
    async (aggregation) => {
      const { service, jwt } = setup();
      await expect(
        service.authorize(
          {
            ...base,
            joins: [detailJoin(), detailJoin("prescription", "p")],
            select: [{ field: "f.amount", aggregation }],
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
      expect(jwt.signQueryRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["count_distinct", "min", "max"])(
    "具备基数依据时允许重复不敏感的 %s",
    async (aggregation) => {
      const { service } = setup();
      await expect(
        service.authorize(
          {
            ...base,
            joins: [detailJoin(), detailJoin("prescription", "p")],
            select: [{ field: "f.amount", aggregation }],
          },
          context,
        ),
      ).resolves.toHaveProperty("request");
    },
  );

  it("单个一对多关联允许汇总唯一父记录下的费用行", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        { ...base, joins: [detailJoin()], select: [{ field: "f.amount", aggregation: "sum" }] },
        context,
      ),
    ).resolves.toHaveProperty("request");
  });

  it("复合分组键未全部用于Join时仍可能扩行", async () => {
    const { service } = setup();
    const fee = detailJoin("fee", "f", true);
    fee.pre_aggregate!.group_by.push("f.name");
    fee.pre_aggregate!.select.push({ field: "f.name", as: "name" });
    await expect(
      service.authorize(
        { ...base, joins: [fee], select: [{ field: "v.id", aggregation: "count" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("缺少基数和键依据的历史关联仅允许明细查询", async () => {
    const { service, configs } = setup();
    for (const config of configs) {
      delete config.unique_keys;
      for (const relation of config.approved_relations) delete relation.cardinality;
    }
    await expect(
      service.authorize({ ...base, joins: [detailJoin()] }, context),
    ).resolves.toHaveProperty("request");
    await expect(
      service.authorize(
        {
          ...base,
          joins: [detailJoin()],
          select: [{ field: "f.id", aggregation: "count_distinct" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("执行时拒绝已失效的一侧唯一键声明", async () => {
    const { service, configs } = setup();
    configs[0].unique_keys = [["id", "name"]];
    await expect(
      service.authorize(
        { ...base, joins: [detailJoin()], select: [{ field: "f.amount", aggregation: "sum" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("先关联原始费用后再关联处方会扩展后加入的处方输入", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        {
          ...base,
          joins: [detailJoin(), detailJoin("prescription", "p", true)],
          select: [{ field: "p.total", aggregation: "sum" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("同一费用对象的两个别名分别计算扩行并施加原始权限", async () => {
    const { service } = setup();
    const request = {
      ...base,
      joins: [detailJoin("fee", "f", true), detailJoin("fee", "p", true)],
      select: [
        { field: "f.total", aggregation: "sum", as: "first" },
        { field: "p.total", aggregation: "sum", as: "second" },
      ],
    };
    const result = await service.authorize(request, {
      ...context,
      dataPolicies: [
        { resource: "fee", field: "org", operator: "eq", value: "org", mandatory: true },
      ],
    });
    expect(result.request.query).toMatchObject({
      joins: [
        { filters: { items: [expect.objectContaining({ field: "f.org" })] } },
        { filters: { items: [expect.objectContaining({ field: "p.org" })] } },
      ],
    });
    await expect(
      service.authorize({ ...request, joins: [detailJoin(), detailJoin("fee", "p")] }, context),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_COLUMN" });
    await expect(
      service.authorize(
        {
          ...request,
          joins: [detailJoin(), detailJoin("fee", "p")],
          select: [{ field: "p.amount", aggregation: "sum" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("分组去重后的主对象可用真实派生唯一键支持明细汇总", async () => {
    const { service, configs } = setup();
    delete configs[0].unique_keys;
    for (const relation of configs[0].approved_relations) delete relation.cardinality;
    const query = {
      ...base,
      from: {
        ...base.from,
        pre_aggregate: {
          group_by: ["v.id", "v.org"],
          select: [
            { field: "v.id", as: "id" },
            { field: "v.org", as: "org" },
          ],
        },
      },
      joins: [detailJoin()],
      select: [{ field: "f.amount", aggregation: "sum" }],
    };
    await expect(service.authorize(query, context)).resolves.toHaveProperty("request");
  });

  it("即使外层直接输出SUM派生字段，其被另一明细扩行时仍拒绝", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        {
          ...base,
          joins: [detailJoin("fee", "f", true), detailJoin("prescription", "p")],
          select: [{ field: "f.total" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });
});

describe("预聚合的字段来源与每层能力授权", () => {
  it.each(
    [
      { aggregation: "min", source: "name", dataType: "string", value: "A" },
      { aggregation: "sum", source: "amount", dataType: "decimal", value: 1 },
      { aggregation: "avg", source: "amount", dataType: "decimal", value: 1 },
    ].flatMap((scenario) =>
      ["filter", "group", "sort"].map((operation) => ({ ...scenario, operation })),
    ),
  )(
    "按唯一键得到的$aggregation派生值仍继承源$operation限制",
    async ({ aggregation, source, dataType, value, operation }) => {
      const { service, configs } = setup();
      configs[0].query_capabilities = {
        groupable_fields: ["id"],
        sortable_fields: [],
        filter_conditions: [],
      };
      const query = {
        ...base,
        from: {
          ...base.from,
          pre_aggregate: {
            group_by: ["v.id"],
            select: [
              { field: "v.id", as: "id" },
              { field: `v.${source}`, aggregation, as: "value" },
            ],
          },
        },
        select: [{ field: "v.value", as: "result" }],
      };
      const change =
        operation === "filter"
          ? {
              filters: {
                logic: "and",
                items: [{ field: "v.value", op: "eq", data_type: dataType, value }],
              },
            }
          : operation === "group"
            ? { group_by: ["v.value"] }
            : { order_by: [{ field: "result", direction: "asc" }] };
      await expect(service.authorize({ ...query, ...change }, context)).rejects.toMatchObject({
        code: "UNSUPPORTED_QUERY",
      });
    },
  );

  it("外层聚合结果别名排序仍继承源排序禁令", async () => {
    const { service, configs } = setup();
    configs[0].query_capabilities = { sortable_fields: [] };
    await expect(
      service.authorize(
        {
          ...base,
          select: [{ field: "v.id", aggregation: "count", as: "total" }],
          order_by: [{ field: "total", direction: "asc" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("获准字符串字段COUNT派生值可按整数过滤并沿用源允许操作", async () => {
    const { service, configs } = setup();
    configs[0].query_capabilities = {
      filter_conditions: [
        { name: "name", data_type: "string", required: false, allowed_ops: ["eq"] },
      ],
    };
    const query = {
      ...base,
      from: {
        ...base.from,
        pre_aggregate: {
          group_by: ["v.id"],
          select: [
            { field: "v.id", as: "id" },
            { field: "v.name", aggregation: "count", as: "total" },
          ],
        },
      },
      select: [{ field: "v.total" }],
      filters: {
        logic: "and",
        items: [{ field: "v.total", op: "eq", data_type: "integer", value: 1 }],
      },
    };
    await expect(service.authorize(query, context)).resolves.toHaveProperty("request");
  });

  it("API能力配置仍受DAS原始聚合白名单约束", async () => {
    const { service, configs, rawDatasets } = setup();
    rawDatasets[0].query_capabilities = {
      aggregations: [{ field: "amount", functions: ["count"] }],
    };
    configs[0].query_capabilities = { aggregations: [{ field: "amount", functions: ["sum"] }] };
    await expect(
      service.authorize({ ...base, select: [{ field: "v.amount", aggregation: "sum" }] }, context),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("对象过滤引用原始列，即使派生度量使用同名输出也保留原始权限类型", async () => {
    const { service } = setup();
    const result = await service.authorize(
      {
        ...base,
        from: {
          ...base.from,
          pre_aggregate: {
            group_by: ["v.id"],
            select: [
              { field: "v.id", as: "key" },
              { field: "v.amount", aggregation: "sum", as: "org" },
            ],
          },
        },
        select: [{ field: "v.org" }],
      },
      {
        ...context,
        dataPolicies: [
          { resource: "visit", field: "org", operator: "eq", value: "org", mandatory: true },
        ],
      },
    );
    expect(result.request.query.from).toMatchObject({
      filters: { items: [{ field: "v.org", data_type: "string", op: "eq", value: "org" }] },
    });
  });

  it("分组键改名仍按真实字段对批准关联", async () => {
    const { service } = setup();
    const fee = detailJoin("fee", "f", true);
    fee.pre_aggregate!.select[0].as = "visit_key";
    fee.on[0].right = "f.visit_key";
    await expect(
      service.authorize(
        { ...base, joins: [fee], select: [{ field: "f.total", aggregation: "sum" }] },
        context,
      ),
    ).resolves.toHaveProperty("request");
  });

  it("聚合输出不能冒充批准关联的原始键", async () => {
    const { service } = setup();
    const fee = detailJoin("fee", "f", true);
    fee.pre_aggregate!.select[0].as = "visit_key";
    fee.pre_aggregate!.select.push({ field: "f.id", aggregation: "count", as: "visit_id" });
    await expect(service.authorize({ ...base, joins: [fee] }, context)).rejects.toMatchObject({
      code: "UNAUTHORIZED_OBJECT",
    });
  });

  it("明确关系ID必须匹配本次完整字段对", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        { ...base, joins: [{ ...detailJoin(), relation_id: "prescription" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_OBJECT" });
  });

  it("外层拒绝预聚合未输出的原始列", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        { ...base, joins: [detailJoin("fee", "f", true)], select: [{ field: "f.amount" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_COLUMN" });
  });

  it.each(["group", "aggregate", "filter"])("检查内层 %s 能力", async (kind) => {
    const { service, configs } = setup();
    configs[1].query_capabilities =
      kind === "group"
        ? { groupable_fields: [] }
        : kind === "aggregate"
          ? { aggregations: [] }
          : { filter_conditions: [] };
    const fee = {
      ...detailJoin("fee", "f", true),
      ...(kind === "filter"
        ? {
            filters: {
              logic: "and",
              items: [{ field: "f.org", op: "eq", data_type: "string", value: "org" }],
            },
          }
        : {}),
    };
    await expect(
      service.authorize({ ...base, joins: [fee], select: [{ field: "f.total" }] }, context),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("字段隐藏后不能通过内层别名恢复访问", async () => {
    const { service, permissions } = setup();
    vi.spyOn(permissions, "listColumnPermissions").mockResolvedValue([
      { role_id: "role", object_id: "fee", column: "amount", effect: "deny" },
    ]);
    await expect(
      service.authorize(
        { ...base, joins: [detailJoin("fee", "f", true)], select: [{ field: "f.total" }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_COLUMN" });
  });

  it("获准的内层SUM产生数值度量，外层AVG明确计算各组金额均值", async () => {
    const { service, configs } = setup();
    configs[1].query_capabilities = { aggregations: [{ field: "amount", functions: ["sum"] }] };
    await expect(
      service.authorize(
        {
          ...base,
          joins: [detailJoin("fee", "f", true)],
          select: [{ field: "f.total", aggregation: "avg" }],
        },
        context,
      ),
    ).resolves.toHaveProperty("request");
  });

  it("原字段仅允许COUNT时，内层计数可在外层SUM形成处方总数", async () => {
    const { service, configs } = setup();
    configs[1].query_capabilities = { aggregations: [{ field: "id", functions: ["count"] }] };
    const fee = detailJoin("fee", "f", true);
    fee.pre_aggregate!.select[2] = { field: "f.id", aggregation: "count", as: "total" };
    await expect(
      service.authorize(
        { ...base, joins: [fee], select: [{ field: "f.total", aggregation: "sum" }] },
        context,
      ),
    ).resolves.toHaveProperty("request");
  });

  it("直接分组投影的改名不能扩大源字段聚合能力", async () => {
    const { service, configs } = setup();
    configs[0].query_capabilities = { aggregations: [{ field: "id", functions: ["count"] }] };
    await expect(
      service.authorize(
        {
          ...base,
          from: {
            ...base.from,
            pre_aggregate: { group_by: ["v.id"], select: [{ field: "v.id", as: "key" }] },
          },
          select: [{ field: "v.key", aggregation: "sum" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("外层筛选派生COUNT必须使用可信整数类型", async () => {
    const { service } = setup();
    const from = {
      ...base.from,
      pre_aggregate: {
        group_by: ["v.org"],
        select: [
          { field: "v.org", as: "org" },
          { field: "v.id", aggregation: "count", as: "total" },
        ],
      },
    };
    await expect(
      service.authorize(
        {
          ...base,
          from,
          select: [{ field: "v.total" }],
          filters: {
            logic: "and",
            items: [{ field: "v.total", op: "eq", data_type: "integer", value: 1 }],
          },
        },
        context,
      ),
    ).resolves.toHaveProperty("request");
    await expect(
      service.authorize(
        {
          ...base,
          from,
          select: [{ field: "v.total" }],
          filters: {
            logic: "and",
            items: [{ field: "v.total", op: "eq", data_type: "string", value: "1" }],
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("外层分组和排序保留分组投影的源能力约束", async () => {
    const { service, configs } = setup();
    configs[0].query_capabilities = { groupable_fields: ["org"], sortable_fields: [] };
    const from = {
      ...base.from,
      pre_aggregate: { group_by: ["v.org"], select: [{ field: "v.org", as: "department" }] },
    };
    await expect(
      service.authorize(
        {
          ...base,
          from,
          select: [{ field: "v.department" }],
          group_by: ["v.department"],
          order_by: [{ field: "v.department", direction: "asc" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("字符串字段不能进行SUM", async () => {
    const { service } = setup();
    await expect(
      service.authorize({ ...base, select: [{ field: "v.name", aggregation: "sum" }] }, context),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
  });

  it("改名分组投影保持原字段脱敏", async () => {
    const { service, configs } = setup();
    configs[0].column_policies = [
      {
        field: "name",
        default_masking: {
          type: "partial_mask",
          prefix_length: 1,
          suffix_length: 0,
          mask_character: "*",
        },
        unmasked_role_ids: [],
      },
    ];
    const { request } = await service.authorize(
      {
        ...base,
        from: {
          ...base.from,
          pre_aggregate: { group_by: ["v.name"], select: [{ field: "v.name", as: "label" }] },
        },
        select: [{ field: "v.label", as: "display" }],
      },
      context,
    );
    expect(request.access.output_masks).toEqual([
      { result_column: "display", rule: configs[0].column_policies[0].default_masking },
    ]);
  });

  it("字符串脱敏策略不能作用于计数派生结果", async () => {
    const { service, configs } = setup();
    configs[0].column_policies = [
      {
        field: "name",
        default_masking: {
          type: "partial_mask",
          prefix_length: 1,
          suffix_length: 0,
          mask_character: "*",
        },
        unmasked_role_ids: [],
      },
    ];
    await expect(
      service.authorize({ ...base, select: [{ field: "v.name", aggregation: "count" }] }, context),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED" });
  });

  it("聚合输出可按默认结果别名排序", async () => {
    const { service } = setup();
    await expect(
      service.authorize(
        {
          ...base,
          select: [{ field: "v.id", aggregation: "count" }],
          order_by: [{ field: "v_id", direction: "desc" }],
        },
        context,
      ),
    ).resolves.toHaveProperty("request");
  });

  it.each([
    { select: [{ field: "v.id" }, { field: "v.amount", aggregation: "sum" }] },
    {
      select: [{ field: "v.id", aggregation: "count" }],
      order_by: [{ field: "v.name", direction: "asc" }],
    },
  ])("拒绝聚合层未分组的选择或排序字段", async (change) => {
    const { service } = setup();
    await expect(service.authorize({ ...base, ...change }, context)).rejects.toMatchObject({
      code: "UNSUPPORTED_QUERY",
    });
  });
});
