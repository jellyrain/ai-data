import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { executableQuerySchema } from "../../src/connectors/executable-query";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";
import {
  mysqlDialect,
  postgresqlDialect,
  sqlServerDialect,
  oracleDialect,
} from "../../src/connectors/dialects";

/** 构造各对象先过滤后连接的物理查询；SQLite 用于验证标准 SQL 的连接语义。 */
function query(type: "left" | "right" = "left") {
  const visit = {
    object_id: "visit",
    native_object_name: "visit",
    alias: "v",
    filters: {
      logic: "and",
      items: [{ field: "v.org", op: "eq", data_type: "string", value: "org" }],
    },
  };
  const detail = {
    object_id: "detail",
    native_object_name: "detail",
    alias: "d",
    filters: {
      logic: "and",
      items: [{ field: "d.dept", op: "eq", data_type: "string", value: "A" }],
    },
  };
  return executableQuerySchema.parse({
    type: "relational_query",
    source_id: "clinical",
    timeout_ms: 1000,
    row_limit: 100,
    from: type === "left" ? visit : detail,
    joins: [
      {
        type,
        relation: type === "left" ? detail : visit,
        on: [
          type === "left"
            ? { left: "v.id", op: "eq", right: "d.visit_id" }
            : { left: "d.visit_id", op: "eq", right: "v.id" },
        ],
      },
    ],
    select: [
      { field: "v.id", as: "id" },
      { field: "d.dept", as: "dept" },
    ],
    filters: { logic: "and", items: [] },
    group_by: [],
    order_by: [{ field: "v.id", direction: "asc" }],
  });
}

describe("对象预过滤 SQL", () => {
  it.each([mysqlDialect, postgresqlDialect, sqlServerDialect, oracleDialect])(
    "$kind 的带值 ON 参数位于对象过滤后，保持外连接匹配语义",
    (dialect) => {
      const input = query();
      if (input.type !== "relational_query") throw new Error("预期关系查询");
      const configured = executableQuerySchema.parse({
        ...input,
        joins: input.joins.map((join) => ({
          ...join,
          on_filters: {
            logic: "and",
            items: [{ field: "v.id", op: "eq", data_type: "integer", value: 1 }],
          },
        })),
      });
      const compiled = compileSqlQuery(configured, dialect);
      expect(compiled.parameters.map((parameter) => parameter.value)).toEqual(["org", "A", 1]);
      expect(compiled.sql).toMatch(/ ON .* AND /);
      if (dialect !== mysqlDialect) return;
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          "CREATE TABLE visit(id INTEGER, org TEXT); CREATE TABLE detail(visit_id INTEGER, dept TEXT); INSERT INTO visit VALUES (1,'org'),(2,'org'),(3,'org'); INSERT INTO detail VALUES (1,'A'),(2,'A');",
        );
        expect(db.prepare(compiled.sql).all("org", "A", 1)).toEqual([
          { id: 1, dept: "A" },
          { id: 2, dept: null },
          { id: 3, dept: null },
        ]);
      } finally {
        db.close();
      }
    },
  );
  it.each([mysqlDialect, postgresqlDialect, sqlServerDialect, oracleDialect])(
    "$kind 在各对象子查询中参数化过滤",
    (dialect) => {
      const compiled = compileSqlQuery(query(), dialect);
      expect(compiled.sql.match(/SELECT \*/g)).toHaveLength(2);
      expect(compiled.sql.match(/WHERE/g)).toHaveLength(2);
      expect(compiled.sql).not.toContain("'org'");
      expect(compiled.parameters.map((parameter) => parameter.value)).toEqual(["org", "A"]);
    },
  );
  it.each(["left", "right"] as const)(
    "%s join 保留授权匹配、仅未授权匹配和无匹配的主记录",
    (type) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          "CREATE TABLE visit(id INTEGER, org TEXT); CREATE TABLE detail(visit_id INTEGER, dept TEXT); INSERT INTO visit VALUES(1,'org'),(2,'org'),(3,'org'),(4,'other'); INSERT INTO detail VALUES(1,'A'),(2,'B'),(4,'A');",
        );
        const compiled = compileSqlQuery(query(type), mysqlDialect);
        const result = db.prepare(compiled.sql).all(
          ...compiled.parameters.map((parameter) => {
            if (typeof parameter.value !== "string") throw new Error("测试样本只使用文本参数");
            return parameter.value;
          }),
        );
        expect(result).toEqual([
          { id: 1, dept: "A" },
          { id: 2, dept: null },
          { id: 3, dept: null },
        ]);
      } finally {
        db.close();
      }
    },
  );
  it("同对象不同别名各自过滤，链式关联的参数按 SQL 位置排列", () => {
    const input = query();
    if (input.type !== "relational_query") throw new Error("测试查询类型错误");
    const extended = executableQuerySchema.parse({
      ...input,
      joins: [
        ...input.joins,
        {
          type: "left",
          relation: {
            object_id: "detail",
            native_object_name: "detail",
            alias: "e",
            filters: {
              logic: "and",
              items: [{ field: "e.dept", op: "eq", data_type: "string", value: "B" }],
            },
          },
          on: [{ left: "v.id", op: "eq", right: "e.visit_id" }],
        },
      ],
      select: [...input.select, { field: "e.dept", as: "other_dept" }],
      filters: {
        logic: "and",
        items: [{ field: "v.id", op: "between", data_type: "integer", value: [1, 3] }],
      },
    });
    const compiled = compileSqlQuery(extended, postgresqlDialect);
    expect(compiled.parameters.map((parameter) => parameter.value)).toEqual([
      "org",
      "A",
      "B",
      1,
      3,
    ]);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE visit(id INTEGER, org TEXT); CREATE TABLE detail(visit_id INTEGER, dept TEXT); INSERT INTO visit VALUES(1,'org'),(2,'org'),(3,'org'),(4,'other'); INSERT INTO detail VALUES(1,'A'),(2,'B'),(4,'A');",
      );
      expect(db.prepare(compiled.sql).all({ $1: "org", $2: "A", $3: "B", $4: 1, $5: 3 })).toEqual([
        { id: 1, dept: "A", other_dept: null },
        { id: 2, dept: null, other_dept: "B" },
        { id: 3, dept: null, other_dept: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("空 OR 查询级条件保持拒绝全量的语义", () => {
    const input = query();
    if (input.type !== "relational_query") throw new Error("测试查询类型错误");
    input.filters = { logic: "or", items: [] };
    expect(compileSqlQuery(input, postgresqlDialect).sql).toContain("WHERE 1 = 0 ORDER BY");
  });

  it("空 OR 对象范围返回空集，不能变成全量范围", () => {
    const input = query();
    if (input.type !== "relational_query") throw new Error("test query");
    const changed = { ...input, from: { ...input.from, filters: { logic: "or", items: [] } } };
    expect(compileSqlQuery(changed as typeof input, postgresqlDialect).sql).toContain(
      "WHERE 1 = 0",
    );
  });
});
