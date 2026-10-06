import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { defineTables } from "./schema.mjs";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const dayjs = require("dayjs");
/** 固定日期及序列驱动的合成数据；独立于数据库和模型。 */
function buildFixture() {
  const tables = defineTables();
  const rows = Object.fromEntries(tables.map((t) => [t.name, t.rows]));
  const stamp = (day, hour = 10) =>
    dayjs("2025-01-01").add(day, "day").hour(hour).format("YYYY-MM-DD HH:mm:ss");
  const after = (time, days) => {
    const next = dayjs(time).add(days, "day").format("YYYY-MM-DD HH:mm:ss");
    return next > "2026-09-27 18:00:00" ? "2026-09-27 18:00:00" : next;
  };
  const add = (name, row) => rows[name].push(row);
  const doctor = (dept) => (dept - 1) * 5 + 1;
  const departmentNames = [
    "内科",
    "外科",
    "妇科",
    "儿科",
    "骨科",
    "眼科",
    "耳鼻喉科",
    "皮肤科",
    "口腔科",
    "康复科",
    "心内科",
    "神经内科",
    "消化科",
    "呼吸科",
    "泌尿科",
    "产科",
    "中医科",
    "健康管理科",
  ];
  for (let i = 1; i <= 3; i++)
    add("campuses", { campus_id: i, name: ["中心院区", "东院区", "西院区"][i - 1] });
  for (let i = 1; i <= 18; i++)
    add("departments", {
      department_id: i,
      campus_id: Math.ceil(i / 6),
      name: departmentNames[i - 1],
    });
  for (let i = 1; i <= 90; i++)
    add("doctors", { doctor_id: i, department_id: Math.ceil(i / 5), name: "测试医生" + i });
  for (let i = 1; i <= 15000; i++)
    add("patients", {
      patient_id: i,
      name: "测试患者" + i,
      sex: i % 2 ? "女" : "男",
      born_on: dayjs("1940-01-01")
        .add((i * 13) % 28000, "day")
        .format("YYYY-MM-DD HH:mm:ss"),
      contact: i % 5 ? "TEST-" + i : null,
    });
  for (let i = 1; i <= 200; i++)
    add("diagnoses", { diagnosis_id: i, code: "DEMO-" + i, name: "演示诊断" + i });
  ["药品", "检查", "检验", "治疗", "手术", "护理", "床位", "材料", "诊察", "其他"].forEach(
    (name, i) => add("charge_categories", { category_id: i + 1, name }),
  );
  for (let i = 1; i <= 300; i++)
    add("charge_items", {
      item_id: i,
      category_id: ((i - 1) % 10) + 1,
      name: rows.charge_categories[(i - 1) % 10].name + "项目" + i,
      unit: "次",
    });
  for (let i = 1; i <= 30000; i++) {
    const dept = ((i - 1) % 17) + 1,
      patient = ((i - 1) % 15000) + 1,
      day = (i * 37) % 628;
    add("registrations", {
      registration_id: i,
      patient_id: patient,
      department_id: dept,
      doctor_id: doctor(dept),
      registered_at: stamp(day, i % 13 === 0 ? 23 : 8),
      status: i <= 24000 ? "completed" : i <= 28000 ? "cancelled" : "waiting",
    });
    if (i <= 24000) {
      add("visits", {
        visit_id: i,
        registration_id: i,
        patient_id: patient,
        department_id: dept,
        doctor_id: doctor(dept),
        visited_at: stamp(day + (i % 13 === 0 ? 1 : 0)),
        status: "completed",
      });
      for (let j = 0; j < (i <= 12000 ? 2 : 1); j++)
        add("visit_diagnoses", {
          visit_diagnosis_id: rows.visit_diagnoses.length + 1,
          visit_id: i,
          department_id: dept,
          diagnosis_id: ((i + j) % 200) + 1,
          is_primary: j === 0 ? 1 : 0,
        });
    }
  }
  for (let i = 1; i <= 12; i++)
    add("wards", { ward_id: i, department_id: i, name: departmentNames[i - 1] + "病区" });
  for (let i = 1; i <= 360; i++)
    add("beds", {
      bed_id: i,
      ward_id: ((i - 1) % 12) + 1,
      department_id: ((i - 1) % 12) + 1,
      name: "床位" + i,
      status: "enabled",
    });
  for (let i = 1; i <= 4000; i++) {
    const bed = ((i - 1) % 360) + 1,
      moved = i <= 2500,
      nextBed = moved ? (bed % 2 ? bed + 1 : bed - 1) : bed;
    const dept = rows.beds[bed - 1].department_id,
      nextDept = rows.beds[nextBed - 1].department_id;
    const start = Math.floor((i - 1) / 360) * 56,
      plannedEnd = stamp(start + (i % 97 === 0 && !moved ? 0 : 8 + (i % 13)), 16);
    const end = i > 3800 || plannedEnd > "2026-09-27 18:00:00" ? null : plannedEnd;
    add("admissions", {
      admission_id: i,
      patient_id: ((i * 7) % 15000) + 1,
      department_id: dept,
      discharge_department_id: nextDept,
      doctor_id: doctor(dept),
      admitted_at: stamp(start, 8),
      discharged_at: end,
      status: end ? "discharged" : "inpatient",
    });
    add("inpatient_stays", {
      stay_id: rows.inpatient_stays.length + 1,
      admission_id: i,
      department_id: dept,
      bed_id: bed,
      started_at: stamp(start, 8),
      ended_at: moved ? stamp(start + 4, 8) : end,
    });
    if (moved)
      add("inpatient_stays", {
        stay_id: rows.inpatient_stays.length + 1,
        admission_id: i,
        department_id: nextDept,
        bed_id: nextBed,
        started_at: stamp(start + 4, 8),
        ended_at: end,
      });
    for (let j = 0; j < (i <= 2000 ? 3 : 2); j++)
      add("inpatient_diagnoses", {
        inpatient_diagnosis_id: rows.inpatient_diagnoses.length + 1,
        admission_id: i,
        department_id: j && end ? nextDept : dept,
        diagnosis_id: ((i + j) % 200) + 1,
        stage: j && end ? "discharge" : "admission",
        is_primary: j < 2 ? 1 : 0,
      });
  }
  for (const inpatient of [false, true]) {
    const prefix = inpatient ? "inpatient" : "outpatient",
      episode = inpatient ? "admission_id" : "visit_id";
    const episodes = rows[inpatient ? "admissions" : "visits"];
    for (const item of episodes) {
      const id = item[episode],
        dept = item.department_id,
        refund = id <= (inpatient ? 600 : 2000) ? 100 : 0;
      const settled = inpatient || id <= 22000,
        count = inpatient ? 45 : 4;
      const firstSettlementId = rows[prefix + "_settlements"].length + 1;
      const base = inpatient ? item.admitted_at : item.visited_at;
      const baseDay = dayjs(base).startOf("day").diff(dayjs("2025-01-01"), "day");
      const charges = [];
      for (let j = 0; j < count; j++) {
        const isReversal = refund > 0 && j === count - 1;
        const chargeDay = inpatient && !(id % 97 === 0 && id > 2500) ? Math.floor(j / 7) : 0;
        const chargeDept =
          inpatient && id <= 2500 && chargeDay >= 4 ? item.discharge_department_id : dept;
        const unit = 200 + (((id + j) * 47) % 3000),
          qty = 1 + (j % 3);
        const charge = {
          charge_id: rows[prefix + "_charge_details"].length + 1,
          [episode]: id,
          department_id: chargeDept,
          ordering_department_id: chargeDept,
          executing_department_id: chargeDept,
          doctor_id: doctor(chargeDept),
          item_id: isReversal ? charges[0].item_id : ((id + j) % 300) + 1,
          settlement_id: settled ? firstSettlementId : null,
          quantity: isReversal ? -1 : qty,
          unit_price_cents: isReversal ? refund : unit,
          amount_cents: isReversal ? -refund : unit * qty,
          original_charge_id: isReversal ? charges[0].charge_id : null,
          charged_at: stamp(baseDay + chargeDay, 12),
          status: "posted",
        };
        charges.push(charge);
        add(prefix + "_charge_details", charge);
      }
      if (!settled) continue;
      const groups = inpatient && id <= 200 ? [charges.slice(0, 21), charges.slice(21)] : [charges];
      for (let part = 0; part < groups.length; part++) {
        const group = groups[part],
          settlementId = rows[prefix + "_settlements"].length + 1;
        group.forEach((charge) => (charge.settlement_id = settlementId));
        const fee = group.reduce((sum, charge) => sum + charge.amount_cents, 0),
          discount = id % 5 === 0 ? 100 : 0;
        const due = fee - discount,
          thisRefund = part === groups.length - 1 ? refund : 0;
        const deposit = inpatient && part === 0 ? Math.floor(due / 3) : 0;
        const unpaid = id > (inpatient ? 3900 : 21000) ? Math.floor(due / 4) : 0;
        const cash = due + thisRefund - deposit - unpaid;
        const split = settlementId <= (inpatient ? 300 : 8000);
        const insurer = split ? Math.floor(cash * 0.3) : 0;
        const settledAt = inpatient
          ? stamp(
              baseDay + (part === 0 && groups.length > 1 ? 3 : id % 97 === 0 && id > 2500 ? 0 : 7),
              15,
            )
          : stamp(baseDay, 15);
        add(prefix + "_settlements", {
          settlement_id: settlementId,
          [episode]: id,
          department_id: dept,
          settled_at: settledAt,
          kind:
            inpatient && (part < groups.length - 1 || !item.discharged_at) ? "interim" : "final",
          status: unpaid ? "partial" : "completed",
          fee_cents: fee,
          discount_cents: discount,
          due_cents: due,
          patient_due_cents: due - insurer,
          insurance_due_cents: insurer,
          deposit_applied_cents: deposit,
          unpaid_cents: unpaid,
        });
        const paymentId = rows[prefix + "_payments"].length + 1;
        add(prefix + "_payments", {
          payment_id: paymentId,
          settlement_id: settlementId,
          [episode]: id,
          department_id: dept,
          payer: "patient",
          channel: "mobile",
          amount_cents: cash - insurer,
          paid_at: settledAt,
          status: "completed",
        });
        if (split)
          add(prefix + "_payments", {
            payment_id: rows[prefix + "_payments"].length + 1,
            settlement_id: settlementId,
            [episode]: id,
            department_id: dept,
            payer: "insurance",
            channel: "insurance",
            amount_cents: insurer,
            paid_at: after(settledAt, 1),
            status: "completed",
          });
        if (thisRefund)
          add(prefix + "_refunds", {
            refund_id: rows[prefix + "_refunds"].length + 1,
            payment_id: paymentId,
            settlement_id: settlementId,
            [episode]: id,
            department_id: dept,
            amount_cents: thisRefund,
            refunded_at: after(settledAt, id % 5 === 0 ? 30 : 1),
            status: "completed",
          });
        if (deposit) {
          const transactionId = rows.inpatient_deposit_transactions.length + 1;
          add("inpatient_deposit_transactions", {
            transaction_id: transactionId,
            admission_id: id,
            department_id: dept,
            settlement_id: null,
            original_transaction_id: null,
            kind: "receive",
            amount_cents: deposit,
            occurred_at: stamp(baseDay, 9),
          });
          add("inpatient_deposit_transactions", {
            transaction_id: transactionId + 1,
            admission_id: id,
            department_id: dept,
            settlement_id: settlementId,
            original_transaction_id: transactionId,
            kind: "apply",
            amount_cents: -deposit,
            occurred_at: settledAt,
          });
          if (id <= 1000) {
            add("inpatient_deposit_transactions", {
              transaction_id: transactionId + 2,
              admission_id: id,
              department_id: dept,
              settlement_id: null,
              original_transaction_id: null,
              kind: "receive",
              amount_cents: 1000,
              occurred_at: stamp(baseDay, 9),
            });
            add("inpatient_deposit_transactions", {
              transaction_id: transactionId + 3,
              admission_id: id,
              department_id: dept,
              settlement_id: null,
              original_transaction_id: transactionId + 2,
              kind: "return",
              amount_cents: -1000,
              occurred_at: dayjs(settledAt).add(1, "day").format("YYYY-MM-DD HH:mm:ss"),
            });
          }
        }
      }
    }
  }
  return tables;
}

/** 依据物理外键和账务恒等式校验；不读取生成过程中的中间计数。 */
function validateFixture(tables) {
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const indexes = Object.fromEntries(
    tables.map((t) => [t.name, new Map(t.rows.map((row) => [row[t.key], row]))]),
  );
  for (const table of tables) {
    assert.equal(indexes[table.name].size, table.rows.length, "主键重复");
    for (const row of table.rows)
      for (const col of table.columns) {
        const value = row[col.name];
        assert.ok(
          value !== undefined && (value !== null || col.nullable),
          table.name + "." + col.name + " 空值",
        );
        if (value !== null && col.type === "int")
          assert.ok(Number.isSafeInteger(value), "整数边界");
        if (value !== null && col.target)
          assert.ok(indexes[col.target].has(value), table.name + "." + col.name + " 关联无效");
      }
  }
  const sumBy = (table, key, value, filter = () => true) => {
    const map = new Map();
    for (const row of byName[table].rows)
      if (filter(row)) map.set(row[key], (map.get(row[key]) ?? 0) + row[value]);
    return map;
  };
  for (const prefix of ["outpatient", "inpatient"]) {
    const fees = sumBy(prefix + "_charge_details", "settlement_id", "amount_cents");
    const pays = sumBy(prefix + "_payments", "settlement_id", "amount_cents");
    const refunds = sumBy(prefix + "_refunds", "settlement_id", "amount_cents");
    const byPayment = sumBy(prefix + "_refunds", "payment_id", "amount_cents");
    for (const settlement of byName[prefix + "_settlements"].rows) {
      const id = settlement.settlement_id;
      assert.equal(fees.get(id), settlement.fee_cents, "费用对账");
      assert.equal(
        settlement.fee_cents - settlement.discount_cents,
        settlement.due_cents,
        "优惠对账",
      );
      assert.equal(
        settlement.patient_due_cents + settlement.insurance_due_cents,
        settlement.due_cents,
        "分摊对账",
      );
      assert.equal(
        (pays.get(id) ?? 0) -
          (refunds.get(id) ?? 0) +
          settlement.deposit_applied_cents +
          settlement.unpaid_cents,
        settlement.due_cents,
        "收退对账",
      );
    }
    for (const pay of byName[prefix + "_payments"].rows)
      assert.ok((byPayment.get(pay.payment_id) ?? 0) <= pay.amount_cents, "退款对账");
  }
  const depositBalances = sumBy("inpatient_deposit_transactions", "admission_id", "amount_cents");
  for (const balance of depositBalances.values()) assert.ok(balance >= 0, "预交金余额对账");
  const applied = sumBy(
    "inpatient_deposit_transactions",
    "settlement_id",
    "amount_cents",
    (row) => row.kind === "apply",
  );
  for (const s of byName.inpatient_settlements.rows)
    assert.equal(
      0 - (applied.get(s.settlement_id) ?? 0),
      s.deposit_applied_cents,
      "预交金抵扣对账",
    );
  const beds = new Map();
  for (const stay of byName.inpatient_stays.rows) {
    assert.ok(stay.ended_at === null || stay.ended_at >= stay.started_at, "轨迹时间");
    const list = beds.get(stay.bed_id) ?? [];
    list.push(stay);
    beds.set(stay.bed_id, list);
  }
  for (const list of beds.values()) {
    list.sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (let i = 1; i < list.length; i++)
      assert.ok(
        list[i - 1].ended_at !== null && list[i - 1].ended_at <= list[i].started_at,
        "床位占用重叠",
      );
  }
  return {
    table_count: tables.length,
    row_count: tables.reduce((sum, t) => sum + t.rows.length, 0),
  };
}
export { buildFixture, validateFixture };
