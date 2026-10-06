import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout } from "node:timers";

// 多会话子进程夹具通过实际 stdio 检查进程复用、事件路由和取消。
const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let threadSequence = 0;
let turnSequence = 0;
let initializations = 0;
const calls = new Map();
const activeTurns = new Map();
const config = Object.fromEntries(
  process.argv.flatMap((value, index) => {
    if (value !== "-c") return [];
    const entry = process.argv[index + 1];
    const equal = entry.indexOf("=");
    return [[entry.slice(0, equal), JSON.parse(entry.slice(equal + 1))]];
  }),
);
const finish = (threadId, turnId, status = "completed") => {
  if (activeTurns.get(threadId) === turnId) activeTurns.delete(threadId);
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status, error: null } },
  });
};
const complete = (threadId, turnId, text) => {
  send({
    method: "item/completed",
    params: { threadId, turnId, item: { id: `message-${turnId}`, type: "agentMessage", text } },
  });
  if (mode === "partial") process.exit(0);
  finish(threadId, turnId);
};
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "init-error") {
      send({
        id: message.id,
        error: { code: -32603, message: "sensitive initialization details" },
      });
      return;
    }
    initializations++;
    assert.equal(message.params.capabilities.experimentalApi, true);
    assert.equal(process.env.AI_DATA_MODEL_API_KEY, "test-key");
    assert.ok(process.env.CODEX_HOME.includes("ai-data-harness-test-"));
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(config["memories.generate_memories"], false);
    assert.equal(config["memories.use_memories"], false);
    assert.equal(config.model_auto_compact_token_limit, undefined);
    send({ id: message.id, result: {} });
    send({ method: "remoteControl/status/changed", params: {}, emittedAtMs: 1789430400000 });
  } else if (["thread/start", "thread/resume"].includes(message.method)) {
    assert.equal(message.params.model, "configured-model");
    if (message.method === "thread/start") {
      assert.equal(message.params.dynamicTools[0].type, "function");
      assert.equal(message.params.dynamicTools[0].name, "query_count");
    }
    const threadId =
      message.params.threadId ??
      (++threadSequence === 1 ? "thread-test" : `thread-${threadSequence}`);
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = `turn-${++turnSequence}`;
    assert.equal(activeTurns.has(threadId), false);
    activeTurns.set(threadId, turnId);
    // 官方可能先推送 started，再返回 turn/start 响应。
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    const input = message.params.input[0].text;
    if (input === "delayed-turn") {
      setTimeout(() => send({ id: message.id, result: { turn: { id: turnId } } }), 80);
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (mode === "exit" || input === "crash") process.exit(0);
    if (mode === "hang" || input === "hold") return;
    if (mode === "partial") {
      complete(threadId, turnId, "未完成内容");
      return;
    }
    if (input === "compact") {
      for (const state of ["started", "completed"])
        send({
          method: `item/${state}`,
          params: { threadId, turnId, item: { id: "compact-1", type: "contextCompaction" } },
        });
    }
    const id = `tool-${turnId}`;
    calls.set(id, { threadId, turnId });
    const params = {
      threadId: mode === "wrong-thread" ? "other-thread" : threadId,
      turnId,
      callId: "call-1",
      tool: mode === "unknown-tool" ? "other_tool" : "query_count",
      namespace: null,
      arguments:
        mode === "multiple"
          ? {
              pid: process.pid,
              initializations,
              threadId,
              home: process.env.CODEX_HOME,
              temp: process.env.TEMP,
              log: config.log_dir,
            }
          : {},
    };
    send({ id, method: "item/tool/call", params });
    if (mode === "duplicate-call") {
      calls.set(id + "-duplicate", { threadId, turnId });
      send({ id: id + "-duplicate", method: "item/tool/call", params });
    }
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    finish(message.params.threadId, message.params.turnId, "interrupted");
  } else if (calls.has(message.id)) {
    const { threadId, turnId } = calls.get(message.id);
    calls.delete(message.id);
    if (message.error) finish(threadId, turnId, "failed");
    else if (mode !== "duplicate-call")
      complete(threadId, turnId, message.result.contentItems[0].text);
  }
});
