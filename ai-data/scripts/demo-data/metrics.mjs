import { writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import { request, administrator } from "./api.mjs";
/** 演示指标固定时间字段与业务粒度，复用已经通过基准核对的目录。 */
function definitions() {
  const specifications = [
    [
      "outpatient-visits",
      "门诊就诊人次（就诊时间）",
      "visits",
      "visit_id",
      "visited_at",
      "count_distinct",
      "门诊人次",
    ],
    [
      "outpatient-patients",
      "门诊患者人数（就诊时间）",
      "visits",
      "patient_id",
      "visited_at",
      "count_distinct",
      "去重患者人数",
    ],
    [
      "admissions",
      "入院人次（入院时间）",
      "admissions",
      "admission_id",
      "admitted_at",
      "count_distinct",
      "入院人次",
    ],
    [
      "discharges",
      "出院人次（出院时间）",
      "admissions",
      "admission_id",
      "discharged_at",
      "count_distinct",
      "出院人次",
    ],
    [
      "outpatient-fees",
      "门诊有效费用（费用发生时间）",
      "outpatient_charge_details",
      "amount_cents",
      "charged_at",
      "sum",
      "门诊费用",
    ],
    [
      "inpatient-fees",
      "住院有效费用（费用发生时间）",
      "inpatient_charge_details",
      "amount_cents",
      "charged_at",
      "sum",
      "住院费用",
    ],
  ];
  return specifications.map(([id, name, table, field, time, aggregation, alias]) => ({
    metric_id: "demo-" + id,
    version: aggregation === "sum" ? 2 : 1,
    name,
    description:
      aggregation === "sum"
        ? `clinical-demo 演示指标，按 ${time} 过滤日期；金额单位为分，包含费用冲销负数，展示元时除以100。可按 c.name 费用分类或 d.name 科室分组，总计在完整授权范围重新计算。`
        : `clinical-demo 演示指标，按 ${time} 过滤日期；按 ${field} 去重计数。支持按科室名称分组，总计在完整授权范围重新计算。`,
    aliases: [alias],
    grain: table,
    deduplication_keys: ["t." + (aggregation === "sum" ? "charge_id" : field)],
    date_basis: { field: "t." + time, data_type: "datetime" },
    query: {
      type: "relational_query",
      source_id: "clinical-demo",
      from: { object_id: "table.dbo." + table, alias: "t" },
      joins: [
        {
          type: "inner",
          object_id: "table.dbo.departments",
          alias: "d",
          on: [{ left: "t.department_id", op: "eq", right: "d.department_id" }],
        },
        ...(aggregation === "sum"
          ? [
              {
                type: "inner",
                object_id: "table.dbo.charge_items",
                alias: "i",
                on: [{ left: "t.item_id", op: "eq", right: "i.item_id" }],
              },
              {
                type: "inner",
                object_id: "table.dbo.charge_categories",
                alias: "c",
                on: [{ left: "i.category_id", op: "eq", right: "c.category_id" }],
              },
            ]
          : []),
      ],
      select: [
        { field: "t." + field, aggregation, as: aggregation === "sum" ? "amount_cents" : "count" },
      ],
      filters: {
        logic: "and",
        items:
          table === "visits"
            ? [{ field: "t.status", op: "eq", data_type: "string", value: "completed" }]
            : [],
      },
    },
    dimensions: aggregation === "sum" ? ["d.name", "c.name"] : ["d.name"],
    value: { type: "column", column: aggregation === "sum" ? "amount_cents" : "count" },
    total_rule: "recalculate",
  }));
}
/** 完整候选、负责人、审核、发布流程均调用现有正式接口。 */
async function publishMetrics() {
  const login = await administrator(),
    token = login.accessToken;
  const published = [];
  try {
    for (const definition of definitions()) {
      let candidate = await request("/admin/metrics", token, definition);
      // 提交幂等回执保留初始状态，后续操作必须读取候选的当前状态。
      candidate = await request("/knowledge-candidates/" + candidate.candidate_id, token);
      if (candidate.status !== "published") {
        if (candidate.owner_id !== login.user.id)
          candidate = await request(
            "/admin/knowledge-candidates/" + candidate.candidate_id + "/owner",
            token,
            { owner_id: login.user.id, expected_version: candidate.version },
          );
        if (candidate.status === "pending")
          candidate = await request(
            "/admin/knowledge-candidates/" + candidate.candidate_id + "/review",
            token,
            {
              expected_version: candidate.version,
              decision: "approve",
              comment: "依据获准演示数据字典、实际目录及 SQL 基准确认指标口径。",
            },
          );
        await request("/admin/knowledge-candidates/" + candidate.candidate_id + "/publish", token, {
          expected_version: candidate.version,
          effective_at: "2026-09-27 00:00:00",
        });
      }
      published.push({
        metric_id: definition.metric_id,
        version: definition.version,
        name: definition.name,
      });
    }
    writeFileSync(
      new URL("../../../任务交接/前端第4步业务造数与验收/指标发布.json", import.meta.url),
      JSON.stringify(published, null, 2) + "\n",
    );
    process.stdout.write(`已发布 ${published.length} 个固定时间口径指标\n`);
  } finally {
    await request("/auth/logout", token, { refresh_token: login.refreshToken });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  publishMetrics().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
export { definitions, publishMetrics };
