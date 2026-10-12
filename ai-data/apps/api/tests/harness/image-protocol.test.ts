import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { testImage } from "../support/test-image";

it("官方进程把图片传入 Responses，重启恢复线程后保留图片上下文", async () => {
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    payloads.push(JSON.parse(body));
    const item = {
      type: "message",
      id: `msg-${payloads.length}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "已收到图片", annotations: [] }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, fields: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", {
      response: { id: `resp-${payloads.length}`, status: "in_progress", output: [] },
    });
    emit("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
    emit("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "已收到图片",
    });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id: `resp-${payloads.length}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const parent = resolve("secrets");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "image-protocol-"));
  const path = join(directory, "sample.image");
  await writeFile(path, testImage());
  const options = {
    provider: {
      id: "image-test",
      model: "rj-model-v1",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
    stateDirectory: directory,
    contextWindow: 32768,
    timeoutMs: 15000,
  };
  let harness = new CodexAnalysisHarness(options);
  let threadId: string | undefined;
  try {
    const run = (images: { path: string; label: string }[]) =>
      harness.run({
        sessionKey: "image-test",
        threadId,
        input: "看看图片",
        images,
        instructions: "回答图片内容",
        tools: [],
        signal: new AbortController().signal,
        onThreadStarted: async (id) => {
          if (threadId) expect(id).toBe(threadId);
          threadId = id;
        },
        executeTool: async () => ({ success: false, output: {} }),
      });
    expect(await run([{ path, label: "第 1 条消息，第 1 张图片" }])).toMatchObject({
      status: "completed",
    });
    expect(JSON.stringify(payloads[0]?.input)).toContain("input_image");
    expect(JSON.stringify(payloads[0]?.input)).toContain("data:image/");
    await harness.close();
    harness = new CodexAnalysisHarness(options);
    expect(await run([])).toMatchObject({ status: "completed" });
    expect(JSON.stringify(payloads[1]?.input)).toContain("input_image");
  } finally {
    await harness.close();
    await new Promise<void>((done) => server.close(() => done()));
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
