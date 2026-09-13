import { describe, expect, it } from "vitest";

import { queryDslSchema } from "../../src/query/query-dsl";

/** 按订单和组织汇总明细，所有后续关联与统计引用声明的输出字段。 */
const preAggregate = {
  group_by: ["line.order_id", "line.organization_id"],
  select: [
    { field: "line.order_id", as: "order_key" },
    { field: "line.organization_id", as: "organization_key" },
    { field: "line.amount", aggregation: "sum", as: "total_amount" },
  ],
};
const query = {
  type: "relational_query",
  source_id: "sales",
  from: { object_id: "sales.order_lines", alias: "line", pre_aggregate: preAggregate },
  select: [{ field: "line.total_amount", aggregation: "sum", as: "amount" }],
};

// 前提：明细在关联前按业务键汇总。验收：合同保留分组输出和原始对象过滤，校验输入及输出边界。
describe("对象内预聚合合同", () => {
  it("主对象按复合键聚合并保存原始字段过滤与最终行数上限", () => {
    const input = {
      ...query,
      from: {
        ...query.from,
        filters: {
          logic: "and",
          items: [{ field: "line.status", op: "eq", data_type: "string", value: "paid" }],
        },
      },
      limit: 5000,
    };

    expect(queryDslSchema.parse(input)).toMatchObject(input);
  });

  it("关联对象可先聚合，再以批准关系和输出字段参与连接", () => {
    const input = {
      ...query,
      from: { object_id: "sales.orders", alias: "orders" },
      joins: [
        {
          type: "left",
          object_id: "sales.order_lines",
          alias: "line",
          relation_id: "order_lines",
          pre_aggregate: preAggregate,
          on: [
            { left: "orders.id", op: "eq", right: "line.order_key" },
            { left: "orders.organization_id", op: "eq", right: "line.organization_key" },
          ],
        },
      ],
    };

    expect(queryDslSchema.parse(input)).toMatchObject(input);
  });

  it("仅输出分组字段时接受复合键去重", () => {
    const input = {
      ...query,
      from: {
        ...query.from,
        pre_aggregate: { ...preAggregate, select: preAggregate.select.slice(0, 2) },
      },
      select: [{ field: "line.order_key" }, { field: "line.organization_key" }],
    };

    expect(queryDslSchema.parse(input)).toMatchObject(input);
  });

  it.each(["count", "count_distinct", "sum", "avg", "min", "max"])(
    "接受已审核的 %s 聚合函数",
    (aggregation) => {
      const input = {
        ...query,
        from: {
          ...query.from,
          pre_aggregate: {
            ...preAggregate,
            select: [
              ...preAggregate.select.slice(0, 2),
              { field: "line.amount", aggregation, as: "total_amount" },
            ],
          },
        },
      };

      expect(queryDslSchema.safeParse(input).success).toBe(true);
    },
  );

  it.each([
    { name: "缺少分组", value: { select: preAggregate.select } },
    { name: "空分组", value: { ...preAggregate, group_by: [] } },
    { name: "缺少输出", value: { group_by: preAggregate.group_by } },
    { name: "空输出", value: { ...preAggregate, select: [] } },
    {
      name: "缺少输出别名",
      value: { group_by: ["line.order_id"], select: [{ field: "line.order_id" }] },
    },
    {
      name: "缺少输入字段",
      value: { group_by: ["line.order_id"], select: [{ as: "order_key" }] },
    },
    {
      name: "未输出全部分组字段",
      value: { ...preAggregate, select: [preAggregate.select[0], preAggregate.select[2]] },
    },
    {
      name: "分组字段仅以聚合输出",
      value: {
        group_by: ["line.order_id"],
        select: [{ field: "line.order_id", aggregation: "count", as: "orders" }],
      },
    },
    {
      name: "非聚合字段未参加分组",
      value: {
        ...preAggregate,
        select: [...preAggregate.select, { field: "line.status", as: "status" }],
      },
    },
    {
      name: "输出别名重复",
      value: {
        ...preAggregate,
        select: [
          ...preAggregate.select,
          { field: "line.amount", aggregation: "max", as: "order_key" },
        ],
      },
    },
    {
      name: "分组字段引用其他对象",
      value: { group_by: ["orders.id"], select: [{ field: "orders.id", as: "order_key" }] },
    },
    {
      name: "聚合字段引用其他对象",
      value: {
        ...preAggregate,
        select: [
          ...preAggregate.select,
          { field: "orders.amount", aggregation: "sum", as: "amount" },
        ],
      },
    },
    {
      name: "输入字段未限定别名",
      value: { group_by: ["order_id"], select: [{ field: "order_id", as: "order_key" }] },
    },
    {
      name: "输入字段含多层限定",
      value: {
        group_by: ["line.raw.order_id"],
        select: [{ field: "line.raw.order_id", as: "order_key" }],
      },
    },
    {
      name: "输入字段包含注入片段",
      value: { group_by: ["line.id;DROP"], select: [{ field: "line.id;DROP", as: "order_key" }] },
    },
    ...["", "line.id", "id;DROP", "1id"].map((as) => ({
      name: `不安全输出别名 ${as}`,
      value: { group_by: ["line.order_id"], select: [{ field: "line.order_id", as }] },
    })),
    {
      name: "未审核聚合函数",
      value: {
        ...preAggregate,
        select: [
          ...preAggregate.select,
          { field: "line.amount", aggregation: "median", as: "median_amount" },
        ],
      },
    },
    {
      name: "未知输出字段",
      value: {
        group_by: ["line.order_id"],
        select: [{ field: "line.order_id", as: "order_key", distinct: true }],
      },
    },
    ...[{ limit: 10 }, { order_by: [] }, { filters: {} }, { joins: [] }].map((extra) => ({
      name: `未知预聚合字段 ${Object.keys(extra)[0]}`,
      value: { ...preAggregate, ...extra },
    })),
  ])("拒绝$name", ({ value }) => {
    expect(
      queryDslSchema.safeParse({ ...query, from: { ...query.from, pre_aggregate: value } }).success,
    ).toBe(false);
  });

  it("关联对象同样要求预聚合输入引用自身别名", () => {
    expect(
      queryDslSchema.safeParse({
        ...query,
        joins: [
          {
            type: "inner",
            object_id: "sales.other_lines",
            alias: "other",
            pre_aggregate: preAggregate,
            on: [{ left: "line.order_key", op: "eq", right: "other.order_key" }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each(["", "relation;DROP TABLE orders", "relation id"])(
    "拒绝不安全的关系标识 %s",
    (relation_id) => {
      expect(
        queryDslSchema.safeParse({
          ...query,
          joins: [
            {
              type: "inner",
              object_id: "sales.orders",
              alias: "orders",
              relation_id,
              on: [{ left: "line.order_key", op: "eq", right: "orders.id" }],
            },
          ],
        }).success,
      ).toBe(false);
    },
  );

  it("参数化对象拒绝预聚合结构", () => {
    expect(
      queryDslSchema.safeParse({
        type: "parameterized_query",
        source_id: "sales",
        from: query.from,
      }).success,
    ).toBe(false);
  });

  it("预聚合查询的最终行数上限仍为 5000", () => {
    expect(queryDslSchema.safeParse({ ...query, limit: 5001 }).success).toBe(false);
  });
});
