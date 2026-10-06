import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
const resultFile = new URL("正式业务验收.json", import.meta.url);
const result = await readFile(resultFile, "utf8")
  .then(JSON.parse)
  .catch(() => ({
    date: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    reports: [],
    checks: [],
  }));
if (result.error) {
  result.attempt_errors ??= [];
  result.attempt_errors.push({
    error: result.error,
    recorded_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    note: "前次自动化等待失败，保留历史；本次从已创建报表继续。",
  });
  delete result.error;
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const saveResult = () => writeFile(resultFile, JSON.stringify(result, null, 2));
const log = (text) => console.log(text);
async function choose(label, option) {
  await page
    .getByRole("combobox", { name: label, exact: true })
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.getByRole("combobox", { name: label, exact: true }).press("Enter");
  if (option instanceof RegExp)
    await page
      .getByRole("combobox", { name: label, exact: true })
      .fill(option.source.replace(/^\^/, "").replaceAll("\\.", "."));
  await page
    .locator(".el-select-dropdown:visible")
    .getByRole("option", { name: option, exact: typeof option === "string" })
    .click();
  await page.keyboard.press("Escape");
}
async function save(title, key) {
  const response = page.waitForResponse(
    (r) =>
      /\/report-definitions$/.test(r.url()) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const res = await response,
    record = await res.json();
  if (!res.ok())
    throw new Error(
      `保存失败 ${res.status()} ${record.message ?? record.code}`,
    );
  const entry = {
    key,
    title,
    report_id: record.report_id,
    version: record.version,
    definition: record.definition,
  };
  result.reports.push(entry);
  await saveResult();
  log(`已创建 ${key} ${record.report_id}`);
  await expect(page).toHaveURL(/\/reports\/[^/]+\/edit/);
  return entry;
}
async function execute(entry) {
  await page.goto(`http://127.0.0.1:5173/reports/${entry.report_id}`);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/reports/${entry.report_id}/execute`) &&
      r.request().method() === "POST",
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  const res = await response,
    execution = await res.json();
  if (!res.ok() || execution.status !== "completed")
    throw new Error(
      `执行失败 ${res.status()} ${execution.error_code ?? execution.message}`,
    );
  entry.executions ??= [];
  entry.executions.push({
    execution_id: execution.execution_id,
    definition_version: execution.definition_version,
    snapshot_version: execution.snapshot?.version,
    parameters: execution.parameters,
    results: execution.results.map((r) => ({
      query_id: r.query_id,
      rows: r.evidence.result.rows,
      sql: r.evidence.sql,
      authorized_query: r.evidence.authorized_query,
    })),
  });
  await saveResult();
  await expect(page.getByText("运行完成", { exact: true })).toBeVisible();
  await page.screenshot({
    path: fileURLToPath(new URL(`${entry.key}-正式结果.png`, import.meta.url)),
    fullPage: true,
  });
  log(`已执行 ${entry.key} ${execution.execution_id}`);
}
async function newPage(title) {
  await page.goto("http://127.0.0.1:5173/reports/new");
  await page.getByLabel("报表标题", { exact: true }).fill(title);
}
async function metric(name) {
  await page.getByRole("button", { name: "添加查询", exact: true }).click();
  await page.getByRole("button", { name: "业务指标", exact: true }).click();
  await page.locator(".dataset-option").filter({ hasText: name }).click();
  await page.getByLabel("指标开始日期").fill("2026-01-01 00:00:00");
  await page.getByLabel("指标结束日期").fill("2026-09-27 23:59:59");
}
try {
  await page.goto("http://127.0.0.1:5173/login");
  await page
    .getByLabel("用户名", { exact: true })
    .fill(config.bootstrap_admin.username);
  await page
    .getByLabel("密码", { exact: true })
    .fill(config.bootstrap_admin.password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
  log("正式登录通过");
  if (!result.reports.some((r) => r.key === "outpatient")) {
    await newPage("门诊科室人次");
    await page.getByRole("button", { name: "添加查询", exact: true }).click();
    await choose("选择数据源", "clinical-demo");
    await page.getByLabel("筛选数据对象").fill("table.dbo.visits");
    await page.locator(".dataset-option").click();
    await page.getByRole("button", { name: "添加关联", exact: true }).click();
    await page
      .locator(".relation-option")
      .filter({ hasText: "table.dbo.departments" })
      .click();
    await page
      .getByRole("button", { name: "添加关联对象", exact: true })
      .click();
    while (
      (await page
        .getByRole("button", { name: "移除字段", exact: true })
        .count()) > 2
    )
      await page
        .getByRole("button", { name: "移除字段", exact: true })
        .last()
        .click();
    await choose("输出字段1", /^t_1\.name/);
    await page.getByLabel("输出名称1", { exact: true }).fill("department_name");
    await choose("输出字段2", /^t\.visit_id/);
    await choose("输出聚合2", "去重计数");
    await page.getByLabel("输出名称2", { exact: true }).fill("visit_count");
    await choose("查询分组字段", /^t_1\.name/);
    await page.getByRole("button", { name: /^报表参数/ }).click();
    await page.getByRole("button", { name: "添加参数", exact: true }).click();
    await page.getByLabel("参数标识1", { exact: true }).fill("department");
    await page.getByLabel("参数名称1", { exact: true }).fill("科室名称");
    await page.getByRole("button", { name: /^数据查询/ }).click();
    await page.getByRole("button", { name: "添加绑定", exact: true }).click();
    await choose("绑定字段1", /^t_1\.name/);
    await page.getByRole("button", { name: "展示配置", exact: true }).click();
    await page.getByRole("button", { name: "添加图表", exact: true }).click();
    await page.getByLabel("区块标题1-1", { exact: true }).fill("门诊科室人次");
    await page.getByLabel("区块标题1-2", { exact: true }).fill("科室人次分布");
    await page.getByRole("button", { name: "画布", exact: true }).click();
    await expect(page.locator(".query-node")).toHaveCount(2);
    await page.getByRole("button", { name: "适应画布" }).click();
    const node = await page.locator(".query-node").first().boundingBox();
    await page.mouse.move(node.x + 60, node.y + 45);
    await page.mouse.down();
    await page.mouse.move(node.x + 85, node.y + 65, { steps: 5 });
    await page.mouse.up();
    await save("门诊科室人次", "outpatient");
  }
  if (!result.reports.some((r) => r.key === "inpatient")) {
    await newPage("住院情况");
    await metric("入院人次（入院时间）");
    await metric("出院人次（出院时间）");
    await save("住院情况", "inpatient");
  }
  if (!result.reports.some((r) => r.key === "fees")) {
    await newPage("门住院有效费用");
    await metric("门诊有效费用（费用发生时间）");
    await metric("住院有效费用（费用发生时间）");
    await save("门住院有效费用", "fees");
  }
  for (const report of result.reports)
    if (!report.executions?.length) await execute(report);
  const outpatient = result.reports.find((r) => r.key === "outpatient");
  if (!outpatient.ai) {
    await page.goto(
      `http://127.0.0.1:5173/reports/${outpatient.report_id}/edit`,
    );
    await page.getByRole("button", { name: "画布", exact: true }).click();
    await page.getByRole("button", { name: "AI 修改", exact: true }).click();
    await page
      .getByLabel("AI 修改要求", { exact: true })
      .fill(
        "仅将当前报表标题改为“门诊科室人次（AI复核）”，保留所有参数、查询、关系、展示配置和布局。完成报表定义修改并保存。",
      );
    const receiptResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/reports/${outpatient.report_id}/revisions`) &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "发送 AI 修改", exact: true })
      .click();
    const response = await receiptResponse,
      receipt = await response.json();
    if (!response.ok()) throw new Error(`AI请求失败 ${response.status()}`);
    outpatient.ai = { receipt, status: "started" };
    await saveResult();
    log("AI修改已开始");
    await expect(page.locator(".report-revision")).toContainText(
      /已保存版本|修改失败|修改已停止/,
      { timeout: 650000 },
    );
    outpatient.ai.status = await page.locator(".revision-progress").innerText();
    await saveResult();
    await page.screenshot({
      path: fileURLToPath(new URL("AI修改-正式.png", import.meta.url)),
      fullPage: true,
    });
    if (!outpatient.ai.status.includes("已保存版本"))
      throw new Error("实际模型修改未成功，见验收记录");
    await execute(outpatient);
  }
  result.checks = [{ name: "三份正式报表及AI修改", passed: true }];
  result.status = "passed";
  await saveResult();
} catch (error) {
  result.error = String(error.message);
  result.status = "failed";
  await saveResult();
  await page
    .screenshot({
      path: fileURLToPath(new URL("正式验收-诊断.png", import.meta.url)),
      fullPage: true,
    })
    .catch(() => {});
  console.log("验收中断：" + result.error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
