import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import process from "node:process";
import { request, administrator } from "./api.mjs";
import { definitions } from "./metrics.mjs";

/** 保存正式健康发现与事务目录调用的对照；只输出业务状态和错误分类。 */
async function diagnose() {
  const session = await administrator();
  try {
    const services = await request("/internal/data-access/services", session.accessToken);
    const catalog = await request("/catalog/datasets/clinical-demo", session.accessToken);
    let metric;
    try {
      const candidate = await request("/admin/metrics", session.accessToken, definitions()[0]);
      metric = { succeeded: true, candidate_id: candidate.candidate_id, status: candidate.status };
    } catch (error) {
      metric = { succeeded: false, error: error.message };
    }
    const result = { services, catalog_objects: catalog.items.length, metric };
    writeFileSync(
      new URL("../../../任务交接/前端第4步业务造数与验收/事务目录复现.json", import.meta.url),
      JSON.stringify(result, null, 2) + "\n",
    );
    process.stdout.write(
      JSON.stringify({ catalog_objects: result.catalog_objects, metric }) + "\n",
    );
  } finally {
    await request("/auth/logout", session.accessToken, { refresh_token: session.refreshToken });
  }
  const rollout = new URL(
    "../../apps/api/secrets/codex-runtime/home/sessions/2026/09/27/rollout-2026-09-27T18-20-54-01a0e261-c71f-7741-9ff6-094f6178938a.jsonl",
    import.meta.url,
  );
  const items = readFileSync(rollout, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((item) => item.type === "response_item")
    .map((item) => item.payload);
  const calls = items.filter(
    (item) => item.type === "function_call" && item.name === "query_dataset",
  );
  const trace = calls.map((call) => {
    const output = items.find(
      (item) => item.type === "function_call_output" && item.call_id === call.call_id,
    )?.output;
    let result;
    try {
      result = JSON.parse(output);
    } catch {
      result = { terminal_message: output };
    }
    return { query: JSON.parse(call.arguments).query, result };
  });
  writeFileSync(
    new URL(
      "../../../任务交接/前端第4步业务造数与验收/outpatient-首次工具记录.json",
      import.meta.url,
    ),
    JSON.stringify({ run_id: "d2d3fd3f-b61d-4d49-87a2-ba4f046d6c55", calls: trace }, null, 2) +
      "\n",
  );
  process.stdout.write(`门诊首次查询工具记录 ${trace.length} 条已保存\n`);
}
diagnose().catch((error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
