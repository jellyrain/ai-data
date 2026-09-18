import { describe, expect, it } from "vitest";
import { QueryPlanner } from "../../src/query-planning/query-planner";

/** 使用本地对象替身，检查条件作用域与物理映射，不连接业务数据库。 */
const planner = new QueryPlanner(
  {
    findEnabledBySourceId: async () => ({
      sourceId: "clinical",
      connectorKind: "sqlserver",
      secretRef: "test",
      timeoutMs: 1000,
      connectionPoolLimit: 1,
      concurrencyLimit: 1,
      rowLimit: 100,
      costLimit: 1,
    }),
  },
  {
    findQueryableBySourceIdAndObjectId: async (sourceId, objectId) => ({
      sourceId,
      objectId,
      objectKind: "table",
      nativeSchemaName: "dbo",
      nativeObjectName: objectId,
      isQueryable: true,
      isDiscoverable: true,
      queryCapabilities: {},
    }),
  },
  { verify: async () => undefined },
);
const condition = (field: string) => ({
  logic: "and",
  items: [{ field, op: "eq", data_type: "string", value: "A" }],
});
const query = {
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visit", alias: "v", filters: condition("v.dept") },
  joins: [
    {
      type: "left",
      object_id: "detail",
      alias: "d",
      filters: condition("d.dept"),
      on: [{ left: "v.id", op: "eq", right: "d.visit_id" }],
    },
  ],
  select: [{ field: "v.id" }],
  filters: condition("v.dept"),
};
const request = (input: unknown) => ({
  query: input,
  signature: "test",
  access: {
    user_id: "user",
    organization_id: "org",
    analysis_run_id: "run",
    policy_version: 1,
    expires_at: "2026-09-13 12:00:00",
  },
});

describe("对象预过滤物理映射", () => {
  it("带值 ON 在对象映射后仍保持匹配阶段", async () => {
    const on_filters = condition("v.dept");
    expect(
      (await planner.plan(request({ ...query, joins: [{ ...query.joins[0], on_filters }] }))).query,
    ).toMatchObject({ joins: [{ on_filters }] });
  });
  it("带值 ON 不能引用未来加入的别名", async () => {
    await expect(
      planner.plan(
        request({ ...query, joins: [{ ...query.joins[0], on_filters: condition("later.dept") }] }),
      ),
    ).rejects.toThrow();
  });
  it("按各对象保存过滤，不将可选侧限制移动到查询级", async () => {
    expect((await planner.plan(request(query))).query).toMatchObject({
      from: { filters: condition("v.dept") },
      joins: [{ relation: { filters: condition("d.dept") } }],
      filters: condition("v.dept"),
    });
  });
  it.each(["d.dept", "v.id.extra", "v."])("主对象过滤拒绝越出当前别名的引用 %s", async (field) => {
    await expect(
      planner.plan(request({ ...query, from: { ...query.from, filters: condition(field) } })),
    ).rejects.toThrow();
  });
  it("关联对象过滤拒绝引用主对象", async () => {
    await expect(
      planner.plan(
        request({ ...query, joins: [{ ...query.joins[0], filters: condition("v.dept") }] }),
      ),
    ).rejects.toThrow();
  });
});
