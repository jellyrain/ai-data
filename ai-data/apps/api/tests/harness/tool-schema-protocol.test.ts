import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { context, createApiDependencies } from "../support/api-fixtures";

it("官方进程仅预载简短入口，按需读取定义后执行原查询，重启后可重读", async () => {
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    payloads.push(JSON.parse(body));
    const sequence = payloads.length;
    const stage = (sequence - 1) % 3;
    const item =
      stage < 2
        ? {
            type: "function_call",
            id: `fc-${sequence}`,
            call_id: `call-${sequence}`,
            name: stage === 0 ? "get_tool_schema" : "query_dataset",
            arguments: JSON.stringify(
              stage === 0
                ? { tool_name: "query_dataset" }
                : {
                    arguments_json: JSON.stringify({
                      query: {
                        type: "relational_query",
                        source_id: "s",
                        from: { object_id: "fees", alias: "f" },
                        select: [{ field: "f.amount" }],
                      },
                    }),
                  },
            ),
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
    emit("response.output_item.added", {
      output_index: 0,
      item: { ...item, ...(stage < 2 ? { arguments: "" } : { content: [] }) },
    });
    if (stage < 2)
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
    else
      emit("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "费用 42",
      });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id: `resp-${sequence}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 },
      },
    });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("协议测试监听失败");
  const parent = resolve("secrets");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "tool-schema-protocol-"));
  const api = createApiDependencies();
  const query = vi.fn(async () => ({
    evidence_id: "e-42",
    result: {
      columns: [{ name: "amount", data_type: "decimal" }],
      rows: [{ amount: 42 }],
      row_count: 1,
      truncated: false,
    },
  }));
  const tools = new AnalysisTools({
    allowedNames: ["get_tool_schema", "query_dataset"],
    catalog: api.catalog.service,
    metrics: { ...api.analysis.metrics, query: vi.fn() },
    reports: api.analysis.reports,
    refreshContext: api.auth.refreshContext,
    listSourceIds: async () => ["s"],
    runs: { assertCurrent: vi.fn(), recordTool: vi.fn(), query, clarify: vi.fn() },
  } as unknown as ConstructorParameters<typeof AnalysisTools>[0]);
  const options = {
    provider: {
      id: "schema-protocol",
      model: "rj-model-v1",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
    stateDirectory: directory,
    contextWindow: 32768,
    timeoutMs: 10000,
  };
  let harness = new CodexAnalysisHarness(options);
  let threadId: string | undefined;
  const run = () =>
    harness.run({
      sessionKey: "schema-protocol",
      threadId,
      input: "读取参数定义并查询费用",
      instructions: "使用业务工具",
      tools: tools.definitions(),
      signal: new AbortController().signal,
      onThreadStarted: async (id) => {
        if (threadId) expect(id).toBe(threadId);
        threadId = id;
      },
      executeTool: (name, input, callId) =>
        tools.execute(
          context,
          "run",
          { owner: "worker", epoch: 1, expires_at: "2026-09-27 23:00:00" },
          name,
          input,
          callId,
        ),
    });
  try {
    expect(await run()).toMatchObject({ status: "completed", content: "费用 42" });
    await harness.close();
    harness = new CodexAnalysisHarness(options);
    expect(await run()).toMatchObject({ status: "completed", content: "费用 42" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(payloads).toHaveLength(6);
    for (const payload of payloads) {
      expect(JSON.stringify(payload.tools)).toContain("arguments_json");
      expect(JSON.stringify(payload.tools)).not.toContain("relational_query");
    }
    expect(JSON.stringify(payloads[0].input)).not.toContain("relational_query");
    expect(JSON.stringify(payloads[1].input)).toContain("relational_query");
    expect(JSON.stringify(payloads[2].input)).toContain("e-42");
  } finally {
    await harness.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
