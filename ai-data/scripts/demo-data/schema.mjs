/** 演示库物理目录；所有 ID 和金额采用可精确计算的有界整数，金额单位为分。 */
function defineTables() {
  const tables = [];
  const table = (name, label, key, fields) => {
    const columns = [{ name: key, type: "int", label: label + "编号" }, ...fields];
    tables.push({ name, label, key, columns, rows: [] });
  };
  const integer = (name, label, target, nullable = false) => ({
    name,
    type: "int",
    label,
    target,
    nullable,
  });
  const text = (name, label, nullable = false) => ({ name, type: "text", label, nullable });
  const time = (name, label, nullable = false) => ({ name, type: "time", label, nullable });
  const ref = (name, target, label = name, nullable = false) =>
    integer(name, label, target, nullable);
  const dept = (name = "department_id", label = "所属科室") => ref(name, "departments", label);
  table("campuses", "院区", "campus_id", [text("name", "院区名称")]);
  table("departments", "科室", "department_id", [
    ref("campus_id", "campuses", "所属院区"),
    text("name", "科室名称"),
  ]);
  table("doctors", "医生", "doctor_id", [dept(), text("name", "医生姓名")]);
  table("patients", "合成患者", "patient_id", [
    text("name", "患者姓名"),
    text("sex", "性别"),
    time("born_on", "出生日期"),
    text("contact", "虚构联系方式", true),
  ]);
  table("diagnoses", "诊断字典", "diagnosis_id", [
    text("code", "诊断代码"),
    text("name", "诊断名称"),
  ]);
  table("charge_categories", "费用分类", "category_id", [text("name", "费用分类名称")]);
  table("charge_items", "收费项目", "item_id", [
    ref("category_id", "charge_categories", "费用分类"),
    text("name", "项目名称"),
    text("unit", "计价单位"),
  ]);
  table("registrations", "门诊挂号", "registration_id", [
    ref("patient_id", "patients", "患者"),
    dept(),
    ref("doctor_id", "doctors", "挂号医生"),
    time("registered_at", "挂号时间"),
    text("status", "挂号状态"),
  ]);
  table("visits", "门诊就诊", "visit_id", [
    ref("registration_id", "registrations", "唯一挂号"),
    ref("patient_id", "patients", "患者"),
    dept(),
    ref("doctor_id", "doctors", "就诊医生"),
    time("visited_at", "就诊时间"),
    text("status", "就诊状态"),
  ]);
  table("visit_diagnoses", "门诊诊断明细", "visit_diagnosis_id", [
    ref("visit_id", "visits", "就诊"),
    dept(),
    ref("diagnosis_id", "diagnoses", "诊断"),
    integer("is_primary", "是否主诊断"),
  ]);
  table("wards", "病区", "ward_id", [dept(), text("name", "病区名称")]);
  table("beds", "床位", "bed_id", [
    ref("ward_id", "wards", "病区"),
    dept(),
    text("name", "床号"),
    text("status", "床位状态"),
  ]);
  table("admissions", "住院记录", "admission_id", [
    ref("patient_id", "patients", "患者"),
    dept(),
    dept("discharge_department_id", "出院或当前科室"),
    ref("doctor_id", "doctors", "主管医生"),
    time("admitted_at", "入院时间"),
    time("discharged_at", "出院时间", true),
    text("status", "住院状态"),
  ]);
  table("inpatient_stays", "住院科室床位轨迹", "stay_id", [
    ref("admission_id", "admissions", "住院"),
    dept(),
    ref("bed_id", "beds", "床位"),
    time("started_at", "入科时间"),
    time("ended_at", "离科时间", true),
  ]);
  table("inpatient_diagnoses", "住院诊断明细", "inpatient_diagnosis_id", [
    ref("admission_id", "admissions", "住院"),
    dept(),
    ref("diagnosis_id", "diagnoses", "诊断"),
    text("stage", "入院或出院诊断"),
    integer("is_primary", "是否主诊断"),
  ]);
  for (const [prefix, episode, target] of [
    ["outpatient", "visit_id", "visits"],
    ["inpatient", "admission_id", "admissions"],
  ]) {
    const label = prefix === "outpatient" ? "门诊" : "住院";
    table(prefix + "_settlements", label + "结算单", "settlement_id", [
      ref(episode, target, label + "记录"),
      dept(),
      time("settled_at", "结算时间"),
      text("kind", "中途或最终结算"),
      text("status", "结算状态"),
      integer("fee_cents", "有效费用分"),
      integer("discount_cents", "优惠分"),
      integer("due_cents", "应付合计分"),
      integer("patient_due_cents", "患者应付分"),
      integer("insurance_due_cents", "医保应付分"),
      integer("deposit_applied_cents", "预交金抵扣分"),
      integer("unpaid_cents", "未收款分"),
    ]);
    table(prefix + "_charge_details", label + "费用明细", "charge_id", [
      ref(episode, target, label + "记录"),
      dept(),
      dept("ordering_department_id", "开单科室"),
      dept("executing_department_id", "执行科室"),
      ref("doctor_id", "doctors", "开单医生"),
      ref("item_id", "charge_items", "收费项目"),
      ref("settlement_id", prefix + "_settlements", "结算单", true),
      integer("quantity", "数量"),
      integer("unit_price_cents", "单价分"),
      integer("amount_cents", "有符号费用分"),
      ref("original_charge_id", prefix + "_charge_details", "原费用", true),
      time("charged_at", "费用发生时间"),
      text("status", "费用状态"),
    ]);
    table(prefix + "_payments", label + "支付流水", "payment_id", [
      ref("settlement_id", prefix + "_settlements", "结算单"),
      ref(episode, target, label + "记录"),
      dept(),
      text("payer", "付款方"),
      text("channel", "支付渠道"),
      integer("amount_cents", "支付金额分"),
      time("paid_at", "支付时间"),
      text("status", "支付状态"),
    ]);
    table(prefix + "_refunds", label + "退款流水", "refund_id", [
      ref("payment_id", prefix + "_payments", "原支付"),
      ref("settlement_id", prefix + "_settlements", "结算单"),
      ref(episode, target, label + "记录"),
      dept(),
      integer("amount_cents", "退款金额分"),
      time("refunded_at", "退款时间"),
      text("status", "退款状态"),
    ]);
  }
  table("inpatient_deposit_transactions", "住院预交金台账", "transaction_id", [
    ref("admission_id", "admissions", "住院"),
    dept(),
    ref("settlement_id", "inpatient_settlements", "关联结算", true),
    ref("original_transaction_id", "inpatient_deposit_transactions", "原台账", true),
    text("kind", "缴入抵扣或退回"),
    integer("amount_cents", "变动金额分"),
    time("occurred_at", "发生时间"),
  ]);
  return tables;
}
export { defineTables };
