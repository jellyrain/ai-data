import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixture, validateFixture } from "../demo-data/fixture.mjs";
import { assertTarget } from "../demo-data/database.mjs";
import { definitions } from "../demo-data/metrics.mjs";

// 基准独立校验数量、外键、费用账及床位区间，生成器不能通过调整校验结果掩盖错误。
test("演示业务库包含 24 张有约束的表和计划数量", () => {
  const tables = buildFixture();
  assert.equal(tables.length, 24);
  assert.equal(
    tables.reduce((sum, table) => sum + table.rows.length, 0),
    475793,
  );
  assert.doesNotThrow(() => validateFixture(tables));
  const fees = tables.find((table) => table.name === "inpatient_charge_details");
  fees.rows[0].admission_id = -1;
  assert.throws(() => validateFixture(tables), /关联/);
});

test("造数金额与退款篡改能够被独立对账发现", () => {
  const tables = buildFixture();
  tables.find((table) => table.name === "outpatient_refunds").rows[0].amount_cents += 100;
  assert.throws(() => validateFixture(tables), /对账/);
});

test("建库脚本拒绝系统库与其他数据库作为写入目标", () => {
  assert.doesNotThrow(() => assertTarget("ai_bi_demo"));
  for (const name of ["ai_to_bi", "master", "ai_bi_demo;DROP", "another"])
    assert.throws(() => assertTarget(name), /目标/);
});

test("费用指标按费用记录标识去重，相同金额的不同费用仍分别计入", () => {
  const fees = definitions().filter((definition) => definition.metric_id.endsWith("-fees"));
  assert.equal(fees.length, 2);
  for (const definition of fees) {
    assert.deepEqual(definition.deduplication_keys, ["t.charge_id"]);
    assert.equal(definition.query.select[0].aggregation, "sum");
    assert.equal(definition.query.select[0].field, "t.amount_cents");
  }
});

test("门住院费用指标支持已批准的费用分类口径并保留科室维度", () => {
  for (const definition of definitions().filter((item) => item.metric_id.endsWith("-fees"))) {
    assert.ok(definition.dimensions.includes("d.name"));
    assert.ok(definition.dimensions.includes("c.name"));
    assert.equal(definition.version, 2);
    assert.deepEqual(
      definition.query.joins.slice(1).map((join) => join.object_id),
      ["table.dbo.charge_items", "table.dbo.charge_categories"],
    );
    assert.equal(definition.date_basis.field, "t.charged_at");
  }
});
