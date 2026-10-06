import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { CodexAppServer } from "../../src/harness/codex-app-server";

// 使用安装的官方进程验证模型可见请求，而非只断言客户端注册字段。
it("官方协议拒绝扁平延迟工具，接入不能仅设置 deferLoading", async () => {
  const payloads: Record<string, unknown>[] = [];
  const protocolErrors: unknown[] = [];
  const receiver = CodexAppServer.prototype as unknown as {
    receive(message: { error?: unknown }): void;
  };
  const original = receiver.receive;
  const receive = vi.spyOn(receiver, "receive").mockImplementation(function (
    this: typeof receiver,
    message,
  ) {
    if (message.error) protocolErrors.push(message.error);
    return original.call(this, message);
  });
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    payloads.push(JSON.parse(body));
    const sequence = payloads.length;
    const item =
      sequence === 1
        ? {
            type: "tool_search_call",
            id: "tsc-1",
            call_id: "discover-1",
            execution: "client",
            status: "completed",
            arguments: { query: "query_fee", limit: 1 },
          }
        : sequence === 2 || sequence === 4
          ? {
              type: "function_call",
              id: `fc-${sequence}`,
              call_id: `call-${sequence}`,
              name: "query_fee",
              arguments: "{}",
            }
          : {
              type: "message",
              id: `msg-${sequence}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "费用 42", annotations: [] }],
            };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, fields: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", {
      response: { id: `resp-${sequence}`, status: "in_progress", output: [] },
    });
    emit("response.output_item.added", { output_index: 0, item });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id: `resp-${sequence}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1000, output_tokens: 30, total_tokens: 1030 },
      },
    });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("协议测试监听失败");
  const parent = resolve("secrets");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "deferred-protocol-"));
  const options = {
    provider: {
      id: "deferred-test",
      model: "rj-model-v1",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
    stateDirectory: directory,
    contextWindow: 32768,
    timeoutMs: 10000,
  };
  const harness = new CodexAnalysisHarness(options);
  let thread: string | undefined;
  const tool = {
    name: "query_fee",
    description: "query_fee 查询费用",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    deferLoading: true,
  };
  const run = () =>
    harness.run({
      sessionKey: "deferred-test",
      threadId: thread,
      input: "查询费用",
      instructions: "按需发现业务工具。",
      tools: [tool],
      signal: new AbortController().signal,
      onThreadStarted: async (id) => {
        if (thread) expect(id).toBe(thread);
        thread = id;
      },
      executeTool: async (name) => {
        calls.push(name);
        return { success: true, output: { fee: 42 } };
      },
    });
  try {
    const first = await run().catch((error: unknown) => ({ error, protocolErrors }));
    expect(first).toMatchObject({
      protocolErrors: [
        expect.objectContaining({
          message: "deferred dynamic tool must include a namespace: query_fee",
        }),
      ],
    });
    expect(payloads).toHaveLength(0);
    expect(calls).toEqual([]);
  } finally {
    await harness.close();
    receive.mockRestore();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
