import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import process from "node:process";
import { request } from "./api.mjs";
import { connect } from "./database.mjs";

/** 读取已发布费用指标，用相同定义的分组与总计核对独立 SQL。 */
async function verify() {
  const accounts = JSON.parse(
    readFileSync(
      new URL("../../apps/api/secrets/clinical-demo-accounts.json", import.meta.url),
      "utf8",
    ),
  );
  const credentials = JSON.parse(
    readFileSync(
      new URL("../../apps/data-access/secrets/clinical-demo.json", import.meta.url),
      "utf8",
    ),
  );
  const session = await request("/auth/login", null, {
    username: accounts[0].username,
    password: accounts[0].password,
  });
  const database = await connect("ai_bi_demo", {
    user: credentials.user,
    password: credentials.password,
  });
  const records = [];
  try {
    for (const kind of ["outpatient", "inpatient"]) {
      const metric = await request(`/metrics/demo-${kind}-fees?version=2`, session.accessToken);
      assert.equal(metric.version, 2);
      assert.ok(metric.dimensions.includes("c.name"));
      const start = kind === "inpatient" ? "2026-01-01 00:00:00" : "2026-09-01 00:00:00";
      const end = "2026-09-27 23:59:59";
      const filters = {
        logic: "and",
        items: [
          metric.query.filters,
          {
            field: metric.date_basis.field,
            op: "between",
            data_type: "datetime",
            value: [start, end],
          },
        ],
      };
      const grouped = await request("/query", session.accessToken, {
        ...metric.query,
        filters,
        group_by: ["c.name"],
        select: [{ field: "c.name", as: "category" }, ...metric.query.select],
      });
      const total = await request("/query", session.accessToken, { ...metric.query, filters });
      const sql = `SELECT c.name AS category,SUM(f.amount_cents) AS amount_cents FROM dbo.${kind}_charge_details f JOIN dbo.charge_items i ON i.item_id=f.item_id JOIN dbo.charge_categories c ON c.category_id=i.category_id WHERE f.charged_at BETWEEN @start AND @end GROUP BY c.name`;
      const expected = (await database.request().input("start", start).input("end", end).query(sql))
        .recordset;
      const normalize = (rows) =>
        rows.map((row) => [row.category, row.amount_cents]).sort(([a], [b]) => a.localeCompare(b));
      assert.deepEqual(normalize(grouped.rows), normalize(expected));
      assert.equal(
        total.rows[0].amount_cents,
        expected.reduce((sum, row) => sum + row.amount_cents, 0),
      );
      records.push({
        metric_id: metric.metric_id,
        version: metric.version,
        start,
        end,
        expected,
        grouped,
        total,
        passed: true,
      });
      process.stdout.write(`${metric.name} v2 分类与总计通过\n`);
    }
    writeFileSync(
      new URL("../../../任务交接/前端第4步业务造数与验收/费用指标v2基准.json", import.meta.url),
      JSON.stringify(records, null, 2) + "\n",
    );
  } finally {
    await database.close();
    await request("/auth/logout", session.accessToken, { refresh_token: session.refreshToken });
  }
}
verify().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
