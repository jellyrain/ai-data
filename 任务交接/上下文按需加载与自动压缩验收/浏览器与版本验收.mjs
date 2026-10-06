import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { request } from "../../ai-data/scripts/demo-data/api.mjs";
const require = createRequire(
  new URL("../../ai-data/apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const account = JSON.parse(
  readFileSync(
    new URL(
      "../../ai-data/apps/api/secrets/clinical-demo-accounts.json",
      import.meta.url,
    ),
    "utf8",
  ),
)[0];
const session = await request("/auth/login", null, {
  username: account.username,
  password: account.password,
});
const fees = JSON.parse(
  readFileSync(new URL("fees-业务验收.json", import.meta.url), "utf8"),
);
const old = JSON.parse(
  readFileSync(
    new URL(
      "../前端第4步业务造数与验收/20260927-模型复验/单工具复验.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const record = { page_errors: [], checks: [] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => record.page_errors.push(error.message));
const wait = async (id) => {
  for (let i = 0; i < 130; i++) {
    const state = await request(`/analysis-runs/${id}`, session.accessToken);
    if (
      ["completed", "failed", "cancelled", "waiting_clarification"].includes(
        state.status,
      )
    ) {
      assert.equal(state.status, "completed", state.error?.message);
      return state;
    }
    await setTimeout(5000);
  }
  throw new Error("验收运行超时");
};
try {
  await page.goto("http://127.0.0.1:5173/login");
  await page.getByLabel("用户名", { exact: true }).fill(account.username);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("textbox", { name: "分析问题" }).waitFor();
  await page.goto("http://127.0.0.1:5173/analysis/" + fees.conversation_id);
  await page.getByText("分析完成", { exact: true }).first().waitFor();
  assert.match(await page.locator("main").innerText(), /2,263,158\.00/);
  await page
    .getByRole("button", { name: "查看分析依据", exact: true })
    .last()
    .click();
  await page.locator(".evidence-item").first().waitFor();
  await page.screenshot({
    path: fileURLToPath(new URL("费用结果与证据.png", import.meta.url)),
    fullPage: true,
  });
  await page.reload();
  await page.getByText("分析完成", { exact: true }).first().waitFor();
  assert.match(await page.locator("main").innerText(), /2,263,158\.00/);
  record.checks.push("费用结果、工具记录、证据与刷新恢复通过");
  await page.goto("http://127.0.0.1:5173/analysis");
  const receiptPromise = page.waitForResponse(
    (response) =>
      /\/conversations\/[^/]+\/messages$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("textbox", { name: "分析问题" })
    .fill("请只调用一次 list_sources，列出当前数据源与数量。");
  await page.getByRole("button", { name: "发送问题" }).click();
  const receipt = await (await receiptPromise).json();
  await wait(receipt.analysisRun.id);
  const current = await request(
    `/conversations/${receipt.message.conversationId}`,
    session.accessToken,
  );
  assert.equal(current.conversation.agentId, "default");
  assert.equal(current.conversation.agentVersion, 2);
  record.new_default = {
    conversation_id: current.conversation.id,
    run_id: receipt.analysisRun.id,
    agent_version: 2,
  };
  record.checks.push("正式浏览器新会话使用 default v2 并完成工具调用");
  await page.screenshot({
    path: fileURLToPath(new URL("默认版本2.png", import.meta.url)),
    fullPage: true,
  });
  const prior = await request(
    `/conversations/${old.conversation_id}/messages`,
    session.accessToken,
    {
      content: "请仍只调用一次 list_sources，重新确认当前的数据源与数量。",
      idempotency_key: randomUUID(),
    },
  );
  await wait(prior.analysisRun.id);
  const oldDetail = await request(
    `/conversations/${old.conversation_id}`,
    session.accessToken,
  );
  assert.equal(oldDetail.conversation.agentVersion, 1);
  record.old_default = {
    conversation_id: old.conversation_id,
    run_id: prior.analysisRun.id,
    agent_version: 1,
  };
  record.checks.push("旧 default v1 会话继续固定旧版本，追问调用和答复通过");
  assert.deepEqual(record.page_errors, []);
  record.passed = true;
} catch (error) {
  record.error = String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await request("/auth/logout", session.accessToken, {
    refresh_token: session.refreshToken,
  });
  writeFileSync(
    new URL("浏览器与版本验收.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record));
}
