import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import dayjs from "../../ai-data/apps/web/node_modules/dayjs/dayjs.min.js";

// 正式接口只读复核：凭据与令牌仅留在进程内，输出保存版本和对比结论。
const config = JSON.parse(
  await readFile(
    new URL("../../ai-data/apps/api/config/api.config.json", import.meta.url),
    "utf8",
  ),
);
const prior = JSON.parse(
  await readFile(new URL("正式业务验收.json", import.meta.url), "utf8"),
);
const base = "http://127.0.0.1:3101";
const response = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: config.bootstrap_admin.username,
    password: config.bootstrap_admin.password,
  }),
});
if (!response.ok) throw new Error(`认证失败 ${response.status}`);
const { accessToken } = await response.json();
async function get(path) {
  const result = await fetch(base + path, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!result.ok) throw new Error(`读取失败 ${path} ${result.status}`);
  return result.json();
}
const reports = [];
for (const entry of prior.reports) {
  const original = await get(
    `/reports/${entry.report_id}/definition?version=1`,
  );
  const latest = await get(`/reports/${entry.report_id}/definition`);
  const history = await get(`/reports/${entry.report_id}/versions`);
  const expected = structuredClone(original.definition);
  if (entry.key === "outpatient") expected.title = "门诊科室人次（AI复核）";
  reports.push({
    report_id: entry.report_id,
    title: latest.definition.title,
    latest_version: latest.version,
    original_definition_preserved: isDeepStrictEqual(
      original.definition,
      entry.definition,
    ),
    latest_definition_matches: isDeepStrictEqual(latest.definition, expected),
    history,
  });
}
const result = {
  date: dayjs().format("YYYY-MM-DD HH:mm:ss"),
  reports,
  passed: reports.every(
    (item) =>
      item.original_definition_preserved && item.latest_definition_matches,
  ),
};
await writeFile(
  new URL("版本与历史复核.json", import.meta.url),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: result.passed,
    reports: reports.map(({ report_id, latest_version }) => ({
      report_id,
      latest_version,
    })),
  }),
);
if (!result.passed) process.exitCode = 1;
