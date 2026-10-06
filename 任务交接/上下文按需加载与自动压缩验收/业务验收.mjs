import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  administrator,
  request,
} from "../../ai-data/scripts/demo-data/api.mjs";

// 专用 Agent 复用现有模型与权限，正式费用数据来自已有合成业务库。
const kind = process.argv[2] ?? "fees";
const prompts = {
  sources:
    "请调用一次 list_sources，只根据返回结果回答当前可用的数据源名称和数量。",
  fees: "请查询 clinical-demo 数据源，统计2026年1月1日至9月27日的住院有效费用，按费用发生时间和费用分类汇总金额。金额字段单位是分，请在回答中换算成元，保留冲销负数。给出各分类费用和合计，并说明费用与支付流水的区别。",
  schema:
    "查询 clinical-demo 的 charge_categories，返回全部费用分类名称和分类编码。请先查看目录详情、按需读取 query_dataset 的参数定义，再通过 query_dataset 查询并给出结果。",
};
assert.ok(prompts[kind]);
const admin = await administrator();
let agent;
try {
  const items = (await request("/agents", admin.accessToken)).items;
  agent = items.find((item) => item.agent_id === "context-acceptance");
  if (!agent) {
    const current = items.find((item) => item.agent_id === "default");
    const definition = Object.fromEntries(
      Object.entries(current).filter(
        ([name]) => !["enabled", "skill_fingerprint"].includes(name),
      ),
    );
    agent = await request("/agents", admin.accessToken, {
      ...definition,
      agent_id: "context-acceptance",
      version: 1,
      name: "上下文按需加载验收",
      tool_names: [...new Set([...definition.tool_names, "get_tool_schema"])],
    });
    writeFileSync(
      new URL("验收Agent.json", import.meta.url),
      JSON.stringify(agent, null, 2) + "\n",
    );
  }
} finally {
  await request("/auth/logout", admin.accessToken, {
    refresh_token: admin.refreshToken,
  });
}
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
const record = {
  kind,
  prompt: prompts[kind],
  agent_id: agent.agent_id,
  agent_version: agent.version,
};
try {
  const conversation = await request("/conversations", session.accessToken, {
    title: `上下文验收-${kind}`,
    agent_id: agent.agent_id,
    agent_version: agent.version,
  });
  record.conversation_id = conversation.id;
  const receipt = await request(
    `/conversations/${conversation.id}/messages`,
    session.accessToken,
    { content: record.prompt, idempotency_key: randomUUID() },
  );
  record.run_id = receipt.analysisRun.id;
  console.log(
    JSON.stringify({
      kind,
      run_id: record.run_id,
      conversation_id: conversation.id,
    }),
  );
  const start = performance.now();
  let last;
  while (performance.now() - start < 650000) {
    record.state = await request(
      `/analysis-runs/${record.run_id}`,
      session.accessToken,
    );
    const label = `${record.state.status}:${record.state.sequence}`;
    if (label !== last) console.log(`${kind} ${label}`);
    last = label;
    if (
      ["completed", "failed", "cancelled", "waiting_clarification"].includes(
        record.state.status,
      )
    )
      break;
    await setTimeout(5000);
  }
  const response = await fetch(
    `http://127.0.0.1:3101/analysis-runs/${record.run_id}/events`,
    {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(response.status, 200);
  record.events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  record.evidence = (
    await request(
      `/analysis-runs/${record.run_id}/evidence`,
      session.accessToken,
    )
  ).items;
  record.detail = await request(
    `/conversations/${conversation.id}`,
    session.accessToken,
  );
  record.elapsed_ms = Math.round(performance.now() - start);
  assert.equal(record.state.status, "completed");
  const calls = record.events.filter((event) => event.type === "tool_call");
  if (kind === "sources")
    assert.deepEqual(
      calls.map((item) => item.tool_name),
      ["list_sources"],
    );
  if (kind === "schema") {
    assert.ok(calls.some((item) => item.tool_name === "get_tool_schema"));
    assert.ok(record.evidence.some((item) => item.result.row_count === 10));
  }
  if (kind === "fees") {
    const expected = JSON.parse(
      readFileSync(
        new URL(
          "../前端第4步业务造数与验收/费用指标v2基准.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).find((item) => item.metric_id === "demo-inpatient-fees");
    const rows = record.evidence.flatMap((item) => item.result.rows);
    const grouped = rows.filter(
      (row) =>
        Object.values(row).some((value) => typeof value === "string") &&
        "amount_cents" in row,
    );
    assert.equal(grouped.length, 10);
    const amounts = grouped
      .map((row) => row.amount_cents)
      .sort((a, b) => a - b);
    assert.deepEqual(
      amounts,
      expected.grouped.rows
        .map((row) => row.amount_cents)
        .sort((a, b) => a - b),
    );
    assert.equal(
      amounts.reduce((a, b) => a + b, 0),
      226315800,
    );
    record.baseline = { categories: 10, total_cents: 226315800, passed: true };
  }
  record.passed = true;
} catch (error) {
  record.error = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    new URL(`${kind}-业务验收.json`, import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      kind,
      status: record.state?.status,
      passed: record.passed,
      error: record.error,
      calls: record.events
        ?.filter((item) => item.type === "tool_call")
        .map((item) => item.tool_name),
    }),
  );
  await request("/auth/logout", session.accessToken, {
    refresh_token: session.refreshToken,
  });
}
