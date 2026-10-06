import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { request } from "../../../ai-data/scripts/demo-data/api.mjs";

// 使用既有验收账号和固定 Agent 版本，检查一次目录工具调用后的最终答复。
const account = JSON.parse(
  readFileSync(
    new URL(
      "../../../ai-data/apps/api/secrets/clinical-demo-accounts.json",
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
  prompt:
    "请调用一次 list_sources，只根据返回结果回答当前可用的数据源名称和数量。",
};
try {
  const conversation = await request("/conversations", session.accessToken, {
    title: "单次工具调用复验",
    agent_id: "default",
    agent_version: 1,
  });
  record.conversation_id = conversation.id;
  const receipt = await request(
    `/conversations/${conversation.id}/messages`,
    session.accessToken,
    {
      content: record.prompt,
      idempotency_key: randomUUID(),
    },
  );
  record.run_id = receipt.analysisRun.id;
  console.log(
    JSON.stringify({ run_id: record.run_id, conversation_id: conversation.id }),
  );
  const started = performance.now();
  let last = "";
  while (performance.now() - started < 650000) {
    record.state = await request(
      `/analysis-runs/${record.run_id}`,
      session.accessToken,
    );
    const label = `${record.state.status}:${record.state.sequence}`;
    if (label !== last) console.log(label);
    last = label;
    if (
      ["completed", "failed", "cancelled", "waiting_clarification"].includes(
        record.state.status,
      )
    )
      break;
    await setTimeout(5000);
  }
  if (
    ["completed", "failed", "cancelled", "waiting_clarification"].includes(
      record.state.status,
    )
  ) {
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
  }
  record.detail = await request(
    `/conversations/${conversation.id}`,
    session.accessToken,
  );
  assert.equal(record.state.status, "completed");
  const calls = record.events.filter((event) => event.type === "tool_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_name, "list_sources");
  assert.ok(
    record.detail.messages.some(
      (message) => message.role === "assistant" && message.content.trim(),
    ),
  );
  console.log("一次工具调用及最终答复通过");
} finally {
  writeFileSync(
    new URL("单工具复验.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  await request("/auth/logout", session.accessToken, {
    refresh_token: session.refreshToken,
  });
}
