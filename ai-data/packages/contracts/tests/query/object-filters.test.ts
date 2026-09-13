import { describe, expect, it } from "vitest";
import { queryDslSchema } from "../../src/query/query-dsl";

/** 同一个递归条件树可用于对象输入和最终查询，执行位置由所在字段确定。 */
const filters = {
  logic: "or",
  items: [
    { field: "v.dept", op: "eq", data_type: "string", value: "A" },
    { logic: "and", items: [{ field: "v.dept", op: "neq", data_type: "string", value: "B" }] },
  ],
};
const query = {
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visit", alias: "v" },
  select: [{ field: "v.id" }],
};

describe("关系对象预过滤合同", () => {
  it("保存主对象与关联对象的递归预过滤", () => {
    const input = {
      ...query,
      from: { ...query.from, filters },
      joins: [
        {
          type: "left",
          object_id: "visit",
          alias: "p",
          filters: {
            logic: "and",
            items: [{ field: "p.dept", op: "eq", data_type: "string", value: "A" }],
          },
          on: [{ left: "v.id", op: "eq", right: "p.id" }],
        },
      ],
    };
    expect(queryDslSchema.parse(input)).toMatchObject(input);
  });
  it("参数化对象通过受控参数表达限制，拒绝对象 filters", () => {
    expect(
      queryDslSchema.safeParse({
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "proc", alias: "v", filters },
      }).success,
    ).toBe(false);
  });
  it("对象条件继续检查值类型与未知字段", () => {
    for (const item of [
      { field: "v.id", op: "eq", data_type: "integer", value: "wrong" },
      { field: "v.id", op: "eq", data_type: "integer", value: 1, extra: true },
    ]) {
      expect(
        queryDslSchema.safeParse({
          ...query,
          from: { ...query.from, filters: { logic: "and", items: [item] } },
        }).success,
      ).toBe(false);
    }
  });
});
