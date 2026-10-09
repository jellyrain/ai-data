import { afterEach, expect, it, vi } from "vitest";
import { CodexSessionRouter } from "../../src/harness/codex-session-router";
import type { HarnessMessage, HarnessRequest } from "../../src/harness/harness-types";

afterEach(() => vi.useRealTimers());
function setup() {
  const events: (HarnessMessage | string)[] = [];
  const controller = new AbortController();
  const request: HarnessRequest = {
    sessionKey: "session",
    input: "查询",
    instructions: "",
    signal: controller.signal,
    tools: [{ name: "query", description: "查询", inputSchema: {} }],
    onThreadStarted: async () => {},
    onMessage: async (event) => {
      events.push(event);
    },
    executeTool: async () => {
      events.push("tool");
      return { success: true, output: {} };
    },
  };
  const router = new CodexSessionRouter("thread", request);
  router.bindTurn("turn");
  const notify = (method: string, value: Record<string, unknown>) =>
    router.notify(method, { threadId: "thread", turnId: "turn", ...value });
  const item = (id: string, text = "", phase = "commentary") => ({
    type: "agentMessage",
    id,
    text,
    phase,
  });
  return { router, request, events, controller, notify, item };
}

it("慢提交时持续合并待处理正文，模型结束后在有限尾批内完整交付", async () => {
  vi.useFakeTimers();
  const h = setup();
  const committed: HarnessMessage[] = [];
  h.request.onMessage = async (event) => {
    const snapshot = { ...event };
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(event).toEqual(snapshot);
    committed.push(snapshot);
  };
  h.notify("item/started", { item: h.item("answer", "", "final_answer") });
  for (let index = 0; index < 90; index++) {
    await vi.advanceTimersByTimeAsync(1000 / 30);
    h.notify("item/agentMessage/delta", { itemId: "answer", delta: "字" });
  }
  h.notify("item/completed", { item: h.item("answer", "字".repeat(90), "final_answer") });
  h.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  let completed = false;
  void h.router.result.then(() => {
    completed = true;
  });
  // 一个在途批次、一个待处理批次和完整正文校准，最多三个提交周期。
  await vi.advanceTimersByTimeAsync(750);
  expect(completed).toBe(true);
  expect(
    committed
      .filter((event) => event.status === "delta")
      .map((event) => event.content)
      .join(""),
  ).toBe("字".repeat(90));
  expect(committed.at(-1)).toMatchObject({ status: "completed", content: "字".repeat(90) });
});

it("阻塞期间超过原队列条数的同段文字仍可合并，压缩和工具保持顺序边界", async () => {
  vi.useFakeTimers();
  const h = setup();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  h.request.onMessage = async (event) => {
    if (event.status === "started") await blocked;
    order.push(`${event.status}:${event.content}`);
  };
  h.request.onCompaction = async () => {
    order.push("compaction");
  };
  h.request.executeTool = async () => {
    order.push("tool");
    return { success: true, output: {} };
  };
  h.notify("item/started", { item: h.item("a") });
  for (let i = 0; i < 150; i++) {
    h.notify("item/agentMessage/delta", { itemId: "a", delta: "甲" });
    await vi.advanceTimersByTimeAsync(120);
  }
  h.notify("item/started", { item: { type: "contextCompaction", id: "compact" } });
  h.notify("item/agentMessage/delta", { itemId: "a", delta: "乙" });
  const call = h.router.call("item/tool/call", {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    tool: "query",
    arguments: {},
  });
  void call.catch(() => {});
  h.notify("item/agentMessage/delta", { itemId: "a", delta: "丙" });
  h.notify("item/completed", { item: h.item("a", "甲".repeat(150) + "乙丙") });
  h.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  release();
  await call;
  await h.router.result;
  expect(order).toEqual([
    "started:",
    `delta:${"甲".repeat(150)}`,
    "compaction",
    "delta:乙",
    "tool",
    "delta:丙",
    `completed:${"甲".repeat(150)}乙丙`,
  ]);
});

it("最终段落缺少完成事件时不能把前一段说明当成最终回答", async () => {
  const h = setup();
  h.notify("item/completed", { item: h.item("comment", "开始查询") });
  h.notify("item/agentMessage/delta", { itemId: "answer", delta: "未完成回答" });
  h.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await expect(h.router.result).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
});

it("取消或提交失败后不交付已经合并的待处理正文", async () => {
  vi.useFakeTimers();
  for (const reason of ["cancel", "failure"]) {
    const h = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: HarnessMessage[] = [];
    h.request.onMessage = async (event) => {
      await blocked;
      if (reason === "failure") throw new Error("提交失败");
      delivered.push({ ...event });
    };
    h.notify("item/started", { item: h.item("a") });
    for (const delta of ["甲", "乙", "丙"]) {
      h.notify("item/agentMessage/delta", { itemId: "a", delta });
      await vi.advanceTimersByTimeAsync(120);
    }
    if (reason === "cancel") h.controller.abort();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered.some((event) => event.status === "delta")).toBe(false);
    if (reason === "failure") await expect(h.router.result).rejects.toThrow("提交失败");
  }
});

it("完成前交付合并文字，工具前后各段按原顺序持久化，完成文本校准该段", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.notify("item/started", { item: h.item("before") });
  for (const delta of ["先", "查", "询"])
    h.notify("item/agentMessage/delta", { itemId: "before", delta });
  await vi.advanceTimersByTimeAsync(150);
  expect(h.events).toContainEqual(
    expect.objectContaining({ itemId: "before", status: "delta", content: "先查询" }),
  );
  h.notify("item/completed", { item: h.item("before", "先查询。") });
  await h.router.call("item/tool/call", {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    tool: "query",
    arguments: {},
  });
  h.notify("item/started", { item: h.item("after", "", "final_answer") });
  h.notify("item/agentMessage/delta", { itemId: "after", delta: "查到 7 人" });
  h.notify("item/completed", { item: h.item("after", "查到 7 人。", "final_answer") });
  h.notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  await expect(h.router.result).resolves.toEqual({
    status: "completed",
    content: "查到 7 人。",
    messageId: "after",
  });
  expect(
    h.events.map((event) =>
      typeof event === "string" ? event : `${event.itemId}:${event.status}`,
    ),
  ).toEqual([
    "before:started",
    "before:delta",
    "before:completed",
    "tool",
    "after:started",
    "after:delta",
    "after:completed",
  ]);
});

it("忽略其他线程轮次、重复完成及推理通知，取消后不交付缓存片段", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.notify("item/agentMessage/delta", { threadId: "other", itemId: "x", delta: "越界" });
  h.notify("item/agentMessage/delta", { turnId: "old", itemId: "x", delta: "越界" });
  h.notify("item/reasoning/textDelta", { itemId: "x", delta: "推理" });
  h.notify("item/completed", { item: h.item("one", "已完成") });
  h.notify("item/completed", { item: h.item("one", "已完成") });
  await vi.advanceTimersByTimeAsync(0);
  h.notify("item/agentMessage/delta", { itemId: "two", delta: "待提交" });
  h.controller.abort();
  await vi.advanceTimersByTimeAsync(150);
  expect(h.events.filter((event) => typeof event !== "string" && event.content)).toEqual([
    expect.objectContaining({ itemId: "one", content: "已完成", status: "completed" }),
  ]);
});

it("持久化失败会阻止后续工具与终态，突发输出受队列容量限制", async () => {
  const h = setup();
  h.request.onMessage = async () => {
    throw new Error("权限已收回");
  };
  h.notify("item/completed", { item: h.item("one", "文字") });
  await expect(h.router.result).rejects.toThrow("权限已收回");
  await expect(
    h.router.call("item/tool/call", {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      tool: "query",
      arguments: {},
    }),
  ).rejects.toThrow();
  expect(h.events).toEqual([]);
  const slow = setup();
  for (let i = 0; i < 201; i++) slow.notify("item/started", { item: slow.item(String(i)) });
  await expect(slow.router.result).rejects.toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
});
