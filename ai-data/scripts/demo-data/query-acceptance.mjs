import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import { connect } from "./database.mjs";
import { request } from "./api.mjs";
const object = (name) => "table.dbo." + name;
const from = (name, alias) => ({ object_id: object(name), alias });
const column = (field, as, aggregation) => ({ field, as, ...(aggregation ? { aggregation } : {}) });
const range = (field) => ({
  field,
  op: "between",
  data_type: "datetime",
  value: ["2026-09-01 00:00:00", "2026-09-27 23:59:59"],
});
const query = (table, alias, select, extra = {}) => ({
  type: "relational_query",
  source_id: "clinical-demo",
  from: from(table, alias),
  select,
  ...extra,
});
const join = (table, alias, left, right, type = "inner") => ({
  ...from(table, alias),
  type,
  on: [{ left, op: "eq", right }],
});
const completed = (field) => ({ field, op: "eq", data_type: "string", value: "completed" });
const cases = [
  {
    name: "门诊科室人次及患者去重",
    query: query(
      "visits",
      "v",
      [
        column("d.name", "department"),
        column("v.visit_id", "visits", "count_distinct"),
        column("v.patient_id", "patients", "count_distinct"),
      ],
      {
        joins: [join("departments", "d", "v.department_id", "d.department_id")],
        filters: { logic: "and", items: [range("v.visited_at"), completed("v.status")] },
        group_by: ["d.name"],
      },
    ),
    sql: "SELECT d.name AS department,COUNT(DISTINCT v.visit_id) AS visits,COUNT(DISTINCT v.patient_id) AS patients FROM dbo.visits v JOIN dbo.departments d ON d.department_id=v.department_id WHERE v.status='completed' AND v.visited_at BETWEEN '2026-09-01' AND '2026-09-27 23:59:59' GROUP BY d.name",
  },
  {
    name: "挂号与就诊 LEFT JOIN",
    query: query(
      "registrations",
      "r",
      [
        column("r.registration_id", "registrations", "count_distinct"),
        column("v.visit_id", "visits", "count_distinct"),
      ],
      { joins: [join("visits", "v", "r.registration_id", "v.registration_id", "left")] },
    ),
    sql: "SELECT COUNT(DISTINCT r.registration_id) AS registrations,COUNT(DISTINCT v.visit_id) AS visits FROM dbo.registrations r LEFT JOIN dbo.visits v ON v.registration_id=r.registration_id",
  },
  {
    name: "诊断与费用多明细关联去重",
    query: query("visits", "v", [column("v.visit_id", "visits", "count_distinct")], {
      joins: [
        join("visit_diagnoses", "d", "v.visit_id", "d.visit_id"),
        join("outpatient_charge_details", "f", "v.visit_id", "f.visit_id"),
      ],
    }),
    sql: "SELECT COUNT(DISTINCT v.visit_id) AS visits FROM dbo.visits v JOIN dbo.visit_diagnoses d ON d.visit_id=v.visit_id JOIN dbo.outpatient_charge_details f ON f.visit_id=v.visit_id",
  },
  {
    name: "住院入院人次",
    query: query("admissions", "a", [column("a.admission_id", "admissions", "count_distinct")], {
      filters: { logic: "and", items: [range("a.admitted_at")] },
    }),
    sql: "SELECT COUNT(DISTINCT admission_id) AS admissions FROM dbo.admissions WHERE admitted_at BETWEEN '2026-09-01' AND '2026-09-27 23:59:59'",
  },
  {
    name: "住院出院人次",
    query: query("admissions", "a", [column("a.admission_id", "discharges", "count_distinct")], {
      filters: { logic: "and", items: [range("a.discharged_at")] },
    }),
    sql: "SELECT COUNT(DISTINCT admission_id) AS discharges FROM dbo.admissions WHERE discharged_at BETWEEN '2026-09-01' AND '2026-09-27 23:59:59'",
  },
  {
    name: "指定时间在院人次",
    query: query("admissions", "a", [column("a.admission_id", "inpatients", "count_distinct")], {
      filters: {
        logic: "and",
        items: [
          {
            field: "a.admitted_at",
            op: "between",
            data_type: "datetime",
            value: ["1900-01-01 00:00:00", "2026-09-27 18:00:00"],
          },
          {
            logic: "or",
            items: [
              { field: "a.discharged_at", op: "is_null", data_type: "datetime" },
              {
                field: "a.discharged_at",
                op: "between",
                data_type: "datetime",
                value: ["2026-09-27 18:00:01", "9999-12-31 23:59:59"],
              },
            ],
          },
        ],
      },
    }),
    sql: "SELECT COUNT(DISTINCT admission_id) AS inpatients FROM dbo.admissions WHERE admitted_at<='2026-09-27 18:00:00' AND (discharged_at IS NULL OR discharged_at>'2026-09-27 18:00:00')",
  },
  {
    name: "住院费用分类与冲销",
    query: query(
      "inpatient_charge_details",
      "f",
      [column("c.name", "category"), column("f.amount_cents", "amount_cents", "sum")],
      {
        joins: [
          join("charge_items", "i", "f.item_id", "i.item_id"),
          join("charge_categories", "c", "i.category_id", "c.category_id"),
        ],
        filters: {
          logic: "and",
          items: [
            {
              field: "f.charged_at",
              op: "between",
              data_type: "datetime",
              value: ["2026-01-01 00:00:00", "2026-09-27 23:59:59"],
            },
          ],
        },
        group_by: ["c.name"],
      },
    ),
    sql: "SELECT c.name AS category,SUM(f.amount_cents) AS amount_cents FROM dbo.inpatient_charge_details f JOIN dbo.charge_items i ON i.item_id=f.item_id JOIN dbo.charge_categories c ON c.category_id=i.category_id WHERE f.charged_at BETWEEN '2026-01-01' AND '2026-09-27 23:59:59' GROUP BY c.name",
  },
  {
    name: "预交金台账收支与抵扣",
    query: query(
      "inpatient_deposit_transactions",
      "t",
      [column("t.kind", "kind"), column("t.amount_cents", "amount_cents", "sum")],
      { group_by: ["t.kind"] },
    ),
    sql: "SELECT kind,SUM(amount_cents) AS amount_cents FROM dbo.inpatient_deposit_transactions GROUP BY kind",
  },
  {
    name: "空时间范围",
    query: query("visits", "v", [column("v.visit_id", "visit_id")], {
      filters: {
        logic: "and",
        items: [
          {
            field: "v.visited_at",
            op: "between",
            data_type: "datetime",
            value: ["1900-01-01 00:00:00", "2023-12-31 23:59:59"],
          },
        ],
      },
    }),
    sql: "SELECT visit_id FROM dbo.visits WHERE visited_at<'2024-01-01'",
  },
];
// 费用、结算、支付和退款分别查询，按独立时间口径核对，避免一对多连接放大金额。
for (const prefix of ["outpatient", "inpatient"]) {
  for (const [suffix, time, fields] of [
    [
      "settlements",
      "settled_at",
      [
        "fee_cents",
        "discount_cents",
        "due_cents",
        "patient_due_cents",
        "insurance_due_cents",
        "deposit_applied_cents",
        "unpaid_cents",
      ],
    ],
    ["payments", "paid_at", ["amount_cents"]],
    ["refunds", "refunded_at", ["amount_cents"]],
  ]) {
    cases.push({
      name: `${prefix} ${suffix} 独立时间与金额`,
      query: query(
        prefix + "_" + suffix,
        "t",
        fields.map((field) => column("t." + field, field, "sum")),
        {
          filters: { logic: "and", items: [range("t." + time)] },
        },
      ),
      sql: `SELECT ${fields.map((field) => `SUM(${field}) AS ${field}`).join(",")} FROM dbo.${prefix}_${suffix} WHERE ${time} BETWEEN '2026-09-01' AND '2026-09-27 23:59:59'`,
    });
  }
}
cases.push({
  name: "挂号时间口径与跨日就诊",
  query: query("visits", "v", [column("v.visit_id", "visits", "count_distinct")], {
    joins: [join("registrations", "r", "v.registration_id", "r.registration_id")],
    filters: { logic: "and", items: [range("r.registered_at"), completed("v.status")] },
  }),
  sql: "SELECT COUNT(DISTINCT v.visit_id) AS visits FROM dbo.visits v JOIN dbo.registrations r ON r.registration_id=v.registration_id WHERE r.registered_at BETWEEN '2026-09-01' AND '2026-09-27 23:59:59' AND v.status='completed'",
});
cases.push({
  name: "全期门诊复诊与跨科室患者去重",
  query: query("visits", "v", [
    column("v.visit_id", "visits", "count_distinct"),
    column("v.patient_id", "patients", "count_distinct"),
  ]),
  sql: "SELECT COUNT(DISTINCT visit_id) AS visits,COUNT(DISTINCT patient_id) AS patients FROM dbo.visits",
});
cases.push({
  name: "门诊费用分类与冲销",
  query: query(
    "outpatient_charge_details",
    "f",
    [column("c.name", "category"), column("f.amount_cents", "amount_cents", "sum")],
    {
      joins: [
        join("charge_items", "i", "f.item_id", "i.item_id"),
        join("charge_categories", "c", "i.category_id", "c.category_id"),
      ],
      filters: { logic: "and", items: [range("f.charged_at")] },
      group_by: ["c.name"],
    },
  ),
  sql: "SELECT c.name AS category,SUM(f.amount_cents) AS amount_cents FROM dbo.outpatient_charge_details f JOIN dbo.charge_items i ON i.item_id=f.item_id JOIN dbo.charge_categories c ON c.category_id=i.category_id WHERE f.charged_at BETWEEN '2026-09-01' AND '2026-09-27 23:59:59' GROUP BY c.name",
});
const normalize = (rows) =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
      ),
    )
    .sort();
/** 独立 SQL 基准与 API→DAS 的 DSL 查询逐项对比，权限由真实测试账号施加。 */
async function queryAcceptance() {
  const accounts = JSON.parse(
    readFileSync(
      new URL("../../apps/api/secrets/clinical-demo-accounts.json", import.meta.url),
      "utf8",
    ),
  );
  const secrets = JSON.parse(
    readFileSync(
      new URL("../../apps/data-access/secrets/clinical-demo.json", import.meta.url),
      "utf8",
    ),
  );
  const database = await connect("ai_bi_demo", { user: secrets.user, password: secrets.password });
  const sessions = [];
  const evidence = [];
  try {
    const full = await request("/auth/login", null, {
      username: accounts[0].username,
      password: accounts[0].password,
    });
    sessions.push(full);
    for (const item of cases) {
      const expected = (await database.request().query(item.sql)).recordset;
      const actual = await request("/query", full.accessToken, item.query);
      assert.deepEqual(normalize(actual.rows), normalize(expected), item.name);
      evidence.push({
        name: item.name,
        sql: item.sql,
        query: item.query,
        expected,
        result: actual,
        passed: true,
      });
      process.stdout.write(item.name + " 通过\n");
    }
    const limited = await request(
      "/query",
      full.accessToken,
      query("visits", "v", [column("v.visit_id", "visit_id")], {
        limit: 100,
        order_by: [{ field: "v.visit_id", direction: "asc" }],
      }),
    );
    assert.equal(limited.rows.length, 100);
    assert.equal(limited.truncated, true);
    evidence.push({ name: "真实 SQL 限额与截断", passed: true, rows: limited.row_count });
    const restricted = await request("/auth/login", null, {
      username: accounts[1].username,
      password: accounts[1].password,
    });
    sessions.push(restricted);
    const scoped = await request(
      "/query",
      restricted.accessToken,
      query(
        "visits",
        "v",
        [column("v.department_id", "department_id"), column("v.visit_id", "visits", "count")],
        { group_by: ["v.department_id"] },
      ),
    );
    const expected = (
      await database
        .request()
        .query(
          "SELECT department_id,COUNT(*) AS visits FROM dbo.visits WHERE department_id=1 GROUP BY department_id",
        )
    ).recordset;
    assert.deepEqual(normalize(scoped.rows), normalize(expected));
    await assert.rejects(
      () =>
        request(
          "/query",
          restricted.accessToken,
          query("patients", "p", [column("p.patient_id", "patient_id")], { limit: 1 }),
        ),
      /UNAUTHORIZED|NOT_FOUND|POLICY_REJECTED/,
    );
    evidence.push({ name: "科室行权限与患者对象拒绝", passed: true, expected, result: scoped });
    for (const table of ["admissions", "inpatient_stays", "inpatient_charge_details"]) {
      const key = {
        admissions: "admission_id",
        inpatient_stays: "stay_id",
        inpatient_charge_details: "charge_id",
      }[table];
      const result = await request(
        "/query",
        restricted.accessToken,
        query(
          table,
          "t",
          [column("t.department_id", "department_id"), column("t." + key, "records", "count")],
          { group_by: ["t.department_id"] },
        ),
      );
      const sql = `SELECT department_id,COUNT(*) AS records FROM dbo.${table} WHERE department_id=1 GROUP BY department_id`;
      const expected = (await database.request().query(sql)).recordset;
      assert.deepEqual(normalize(result.rows), normalize(expected), table + " 科室权限");
      evidence.push({ name: table + " 科室行权限", passed: true, sql, expected, result });
    }
    writeFileSync(
      new URL("../../../任务交接/前端第4步业务造数与验收/SQL与API基准.json", import.meta.url),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    process.stdout.write(`真实 SQL/API 验收 ${evidence.length} 项通过\n`);
  } finally {
    await database.close();
    for (const session of sessions)
      await request("/auth/logout", session.accessToken, { refresh_token: session.refreshToken });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  queryAcceptance().catch((error) => {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
  });
export { cases, queryAcceptance };
