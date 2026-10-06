import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { request } from "./api.mjs";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const evidence = new URL("../../../任务交接/前端第4步业务造数与验收/", import.meta.url);
const prompts = {
  outpatient:
    "请查询 clinical-demo 数据源，统计 2026年9月1日00:00:00 至2026年9月27日23:59:59，按就诊时间口径，各科室的门诊就诊人次和去重患者人数。只统计 completed 就诊，显示科室名称，给出表格和总计。请直接根据目录与真实查询回答。",
  inpatient:
    "请查询 clinical-demo 数据源，分别统计2026年9月1日至9月27日的入院人次、出院人次，以及2026年9月27日18:00:00仍在院的人次，按对应的入院时间、出院时间和入出院区间统计。人次按 admission_id 去重。给出清晰表格并说明各个时间口径。",
  fees: "请查询 clinical-demo 数据源，统计2026年1月1日至9月27日的住院有效费用，按费用发生时间和费用分类汇总金额。金额字段单位是分，请在回答中换算成元，保留冲销负数。给出各分类费用和合计，并说明费用与支付流水的区别。",
};
/** 使用正式页面发问，保存真实模型运行、证据、截图及刷新追问结果。 */
async function browserAcceptance(kind = process.argv[2] ?? "outpatient") {
  if (!prompts[kind]) throw new Error("未知验收场景");
  const account = JSON.parse(
    readFileSync(
      new URL("../../apps/api/secrets/clinical-demo-accounts.json", import.meta.url),
      "utf8",
    ),
  )[0];
  const session = await request("/auth/login", null, {
    username: account.username,
    password: account.password,
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const receipts = [],
    sse = [];
  page.on("response", async (response) => {
    if (
      /\/conversations\/[^/]+\/messages$/.test(response.url()) &&
      response.request().method() === "POST" &&
      response.ok()
    )
      receipts.push(await response.json());
    if (response.url().includes("/events")) sse.push(response.status());
  });
  const runs = [];
  const waitRun = async (index) => {
    for (let i = 0; i < 30 && !receipts[index]; i++) await setTimeout(500);
    assert.ok(receipts[index], "页面取得真实消息回执");
    const id = receipts[index].analysisRun.id;
    let last = "";
    for (let i = 0; i < 130; i++) {
      const state = await request("/analysis-runs/" + id, session.accessToken);
      const label = state.status + ":" + state.sequence;
      if (label !== last) {
        process.stdout.write(`${kind} ${label}\n`);
        last = label;
      }
      if (["completed", "failed", "cancelled", "waiting_clarification"].includes(state.status)) {
        const saved = (await request("/analysis-runs/" + id + "/evidence", session.accessToken))
          .items;
        const eventsResponse = await globalThis.fetch(
          "http://127.0.0.1:3101/analysis-runs/" + id + "/events",
          {
            headers: { Authorization: "Bearer " + session.accessToken },
            signal: globalThis.AbortSignal.timeout(10000),
          },
        );
        const events = (await eventsResponse.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        runs.push({ id, state, evidence: saved, events });
        assert.equal(
          state.status,
          "completed",
          JSON.stringify({ status: state.status, error: state.error }),
        );
        return;
      }
      await setTimeout(5000);
    }
    throw new Error("模型运行未在验收时间内完成");
  };
  try {
    await page.goto("http://127.0.0.1:5173/login");
    await page.getByLabel("用户名", { exact: true }).fill(account.username);
    await page.getByLabel("密码", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "登录工作台", exact: true }).click();
    await page.getByRole("textbox", { name: "分析问题" }).waitFor();
    const existingRun = process.argv[3],
      existingConversation = process.argv[4];
    if (existingRun && existingConversation) {
      assert.match(existingRun, /^[a-f0-9-]{36}$/);
      assert.match(existingConversation, /^[a-f0-9-]{36}$/);
      receipts.push({ analysisRun: { id: existingRun } });
      await page.goto("http://127.0.0.1:5173/analysis/" + existingConversation);
    } else {
      await page.getByRole("textbox", { name: "分析问题" }).fill(prompts[kind]);
      await page.getByRole("button", { name: "发送问题" }).click();
    }
    await waitRun(0);
    await page.getByText("分析完成", { exact: true }).first().waitFor({ timeout: 20000 });
    assert.ok(runs[0].evidence.length > 0, "真实模型保存查询证据");
    await page.getByRole("button", { name: "查看分析依据", exact: true }).last().click();
    await page.locator(".evidence-item").first().waitFor();
    await page.screenshot({
      path: fileURLToPath(new URL(kind + "-结果.png", evidence)),
      fullPage: true,
    });
    const tables = runs[0].events.filter((event) => event.type === "table");
    const chartIndex = tables.findIndex(
      (table) =>
        table.columns.some((column) => ["string", "date", "datetime"].includes(column.data_type)) &&
        table.columns.some((column) => ["integer", "decimal"].includes(column.data_type)),
    );
    const result = page.locator(".result-view").nth(Math.max(0, chartIndex));
    if (chartIndex >= 0 && (await result.count())) {
      await result.locator(".chart-kind").click();
      await page.getByRole("option", { name: "柱状图", exact: true }).click();
      await page.locator("canvas").first().waitFor();
      await page.screenshot({
        path: fileURLToPath(new URL(kind + "-图表.png", evidence)),
        fullPage: true,
      });
    }
    const url = page.url();
    await page.reload();
    await page.getByText("分析完成", { exact: true }).first().waitFor({ timeout: 20000 });
    assert.equal(page.url(), url, "刷新恢复同一会话");
    if (kind === "outpatient") {
      await page
        .getByRole("textbox", { name: "分析问题" })
        .fill(
          "请仅根据上一轮已经返回的查询结果，说明门诊就诊人次最多的科室及其人次，不要再次查询数据库。",
        );
      await page.getByRole("button", { name: "发送问题" }).click();
      await waitRun(1);
      assert.equal(runs[1].evidence.length, 0, "基于已有结果的追问没有新证据");
      assert.equal(
        runs[1].events.filter(
          (e) => e.type === "tool_call" && ["query_dataset", "query_metric"].includes(e.tool_name),
        ).length,
        0,
        "追问不重复执行数据查询",
      );
      await page.screenshot({
        path: fileURLToPath(new URL(kind + "-追问恢复.png", evidence)),
        fullPage: true,
      });
    }
    assert.equal(errors.length, 0, "页面无异常");
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    process.stdout.write(`${kind} 浏览器流程通过\n`);
  } catch (error) {
    await page
      .screenshot({ path: fileURLToPath(new URL(kind + "-诊断.png", evidence)), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    writeFileSync(
      new URL(kind + "-模型验收.json", evidence),
      JSON.stringify(
        { kind, prompt: prompts[kind], receipts, runs, page_errors: errors, sse },
        null,
        2,
      ) + "\n",
    );
    await browser.close();
    await request("/auth/logout", session.accessToken, { refresh_token: session.refreshToken });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  browserAcceptance().catch((error) => {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
  });
export { browserAcceptance };
