import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { connect } from "../../ai-data/scripts/demo-data/database.mjs";
const data = JSON.parse(
  await readFile(new URL("正式业务验收.json", import.meta.url), "utf8"),
);
const credentials = JSON.parse(
  await readFile(
    new URL(
      "../../ai-data/apps/data-access/secrets/clinical-demo.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const database = await connect("ai_bi_demo", {
  user: credentials.user,
  password: credentials.password,
});
const results = [];
const normal = (rows) =>
  rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .map((row) => JSON.stringify(row))
    .sort();
try {
  for (const report of data.reports) {
    for (const execution of report.executions) {
      for (const query of execution.results) {
        let sql;
        if (report.key === "outpatient")
          sql =
            "SELECT d.name AS department_name,COUNT(DISTINCT v.visit_id) AS visit_count FROM dbo.visits v LEFT JOIN dbo.departments d ON v.department_id=d.department_id GROUP BY d.name";
        else if (report.key === "inpatient") {
          const column =
            query.query_id === "query_1" ? "admitted_at" : "discharged_at";
          sql = `SELECT d.name AS dimension_0,COUNT(DISTINCT a.admission_id) AS count FROM dbo.admissions a JOIN dbo.departments d ON a.department_id=d.department_id WHERE a.${column} BETWEEN @start AND @end GROUP BY d.name`;
        } else {
          const table =
            query.query_id === "query_1"
              ? "outpatient_charge_details"
              : "inpatient_charge_details";
          sql = `SELECT d.name AS dimension_0,SUM(f.amount_cents) AS amount_cents FROM dbo.${table} f JOIN dbo.departments d ON f.department_id=d.department_id WHERE f.charged_at BETWEEN @start AND @end GROUP BY d.name`;
        }
        const expected = (
          await database
            .request()
            .input("start", "2026-01-01 00:00:00")
            .input("end", "2026-09-27 23:59:59")
            .query(sql)
        ).recordset;
        assert.deepEqual(normal(query.rows), normal(expected));
        results.push({
          report_id: report.report_id,
          execution_id: execution.execution_id,
          definition_version: execution.definition_version,
          query_id: query.query_id,
          sql,
          rows: expected.length,
          total: expected.reduce(
            (sum, row) =>
              sum + (row.visit_count ?? row.count ?? row.amount_cents),
            0,
          ),
          passed: true,
        });
      }
    }
  }
  await writeFile(
    new URL("SQL对账.json", import.meta.url),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results.map(({ sql, ...result }) => result)));
} finally {
  await database.close();
}
