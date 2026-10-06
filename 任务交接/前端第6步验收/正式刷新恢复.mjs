import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  chromium,
  expect,
} from "../../ai-data/apps/web/node_modules/@playwright/test/index.mjs";
import dayjs from "../../ai-data/apps/web/node_modules/dayjs/dayjs.min.js";

const config = JSON.parse(
  await readFile(
    new URL("../../ai-data/apps/api/config/api.config.json", import.meta.url),
    "utf8",
  ),
);
const acceptance = JSON.parse(
  await readFile(new URL("正式业务验收.json", import.meta.url), "utf8"),
);
const original = acceptance.reports.find((item) => item.key === "outpatient");
const reportId = original.report_id,
  runId = original.ai.receipt.analysis_run_id;
const base = "http://127.0.0.1:3101",
  web = "http://127.0.0.1:5173";
const result = {
  date: dayjs().format("YYYY-MM-DD HH:mm:ss"),
  report_id: reportId,
  analysis_run_id: runId,
  checks: [],
  passed: false,
};
const browser = await chromium.launch({ headless: true });
try {
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: config.bootstrap_admin.username,
      password: config.bootstrap_admin.password,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!login.ok) throw new Error(`认证失败 ${login.status}`);
  const { accessToken } = await login.json();
  const headers = { authorization: `Bearer ${accessToken}` };
  const request = (path) =>
    fetch(base + path, { headers, signal: AbortSignal.timeout(20000) });
  const get = async (path) => {
    const response = await request(path);
    if (!response.ok) throw new Error(`读取失败 ${response.status}`);
    return response.json();
  };
  const before = await get(`/reports/${reportId}/versions`);
  const runBefore = await get(`/analysis-runs/${runId}`);
  const response = await request(`/reports/${reportId}/revisions/${runId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  result.binding = await response.json();
  expect(result.binding).toEqual({
    report_id: reportId,
    analysis_run_id: runId,
    expected_version: 1,
  });
  result.checks.push({ name: "真实修订绑定及禁止缓存", passed: true });
  for (const id of [
    acceptance.reports[1].report_id,
    acceptance.reports[2].report_id,
  ]) {
    expect((await request(`/reports/${id}/revisions/${runId}`)).status).toBe(
      404,
    );
  }
  expect(
    (await fetch(`${base}/reports/${reportId}/revisions/${runId}`)).status,
  ).toBe(401);
  result.checks.push({ name: "同账号其他报表拒绝及未登录拒绝", passed: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(`${web}/login`);
  await page
    .getByLabel("用户名", { exact: true })
    .fill(config.bootstrap_admin.username);
  await page
    .getByLabel("密码", { exact: true })
    .fill(config.bootstrap_admin.password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
  const writes = [],
    errors = [];
  let bindings = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method()) &&
      !req.url().includes("/auth/")
    )
      writes.push({ method: req.method(), path: new URL(req.url()).pathname });
    if (req.url().endsWith(`/revisions/${runId}`) && req.method() === "GET")
      bindings++;
  });
  await page.goto(`${web}/reports/${reportId}/edit?revision=${runId}`);
  await expect(page.locator(".revision-progress")).toContainText(
    "已保存版本 2",
    { timeout: 45000 },
  );
  await page.reload();
  await expect(page.locator(".revision-progress")).toContainText(
    "已保存版本 2",
    { timeout: 45000 },
  );
  await expect(page.getByLabel("报表标题", { exact: true })).toHaveValue(
    "门诊科室人次（AI复核）",
  );
  await expect(page.getByLabel("报表标题", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.locator(".query-node")).toHaveCount(2);
  await page.screenshot({
    path: fileURLToPath(new URL("AI恢复-正式.png", import.meta.url)),
    fullPage: true,
  });
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  expect(bindings).toBeGreaterThanOrEqual(2);
  result.checks.push({
    name: "浏览器进入及刷新恢复已提交 v2，保持可编辑",
    passed: true,
  });
  const after = await get(`/reports/${reportId}/versions`);
  const runAfter = await get(`/analysis-runs/${runId}`);
  expect(isDeepStrictEqual(before, after)).toBe(true);
  expect(isDeepStrictEqual(runBefore, runAfter)).toBe(true);
  result.checks.push({
    name: "恢复不产生业务写入，定义、快照和运行保持一致",
    passed: true,
  });
  result.definitions = after.definitions.map((item) => item.version);
  result.snapshot_count = after.snapshots.length;
  result.business_writes = writes;
  result.browser_errors = errors;
  result.binding_reads = bindings;
  result.passed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    new URL("正式刷新恢复.json", import.meta.url),
    JSON.stringify(result, null, 2),
  );
}
console.log(JSON.stringify(result));
