import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { SkillResources } from "../../src/skills/skill-resources";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { context, createApiDependencies } from "../support/api-fixtures";

it("官方运行时先加载 Skill 入口，按需读取子文档，再将查询错误交回模型", async () => {
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    payloads.push(JSON.parse(body) as Record<string, unknown>);
    if (payloads.length <= 2) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const item = {
        type: "function_call",
        id: `fc-${payloads.length}`,
        call_id: `call-${payloads.length}`,
        name: payloads.length === 1 ? "read_skill_reference" : "query_count",
        arguments:
          payloads.length === 1
            ? JSON.stringify({
                skill_name: "query-dsl",
                relative_path: "references/relational-query.md",
              })
            : "{}",
      };
      const emit = (type: string, fields: Record<string, unknown>) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      emit("response.created", {
        response: { id: `resp-${payloads.length}`, status: "in_progress", output: [] },
      });
      emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } });
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", {
        response: {
          id: `resp-${payloads.length}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 },
        },
      });
      response.end();
      return;
    }
    // 接收真实协议后主动结束，不调用外部模型。
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "协议采样结束", type: "invalid_request_error" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试监听地址无效");
  const root = resolve("secrets");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "ai-data-protocol-test-"));
  let harness: CodexAnalysisHarness | undefined;
  try {
    const skillsDirectory = fileURLToPath(new URL("../../../../packages/skills/", import.meta.url));
    const skills = new SkillResources(skillsDirectory);
    const api = createApiDependencies();
    const audit = vi.fn(async () => {});
    const tools = new AnalysisTools({
      skills,
      runs: { assertCurrent: vi.fn(async () => {}), recordTool: audit },
      refreshContext: api.auth.refreshContext,
    } as unknown as ConstructorParameters<typeof AnalysisTools>[0]);
    harness = new CodexAnalysisHarness({
      provider: {
        id: "protocol-test",
        model: "protocol-test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      stateDirectory: directory,
      skills,
      contextWindow: 32768,
      timeoutMs: 10000,
    });
    await expect(
      harness.run({
        sessionKey: "protocol-test",
        input: "查询人数",
        instructions: "遵循已提供的业务 Skill。",
        tools: [
          tools.definitions().find((tool) => tool.name === "read_skill_reference")!,
          {
            name: "query_count",
            description: "查询人数",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        signal: new AbortController().signal,
        onThreadStarted: async () => {},
        executeTool: async (name, input, id) =>
          name === "read_skill_reference"
            ? tools.execute(
                context,
                "run",
                { owner: "worker", epoch: 1, expires_at: "2026-09-16 23:00:00" },
                name,
                input,
                id,
              )
            : {
                success: false,
                output: { code: "UNSUPPORTED_QUERY", message: "对象不支持参数化查询" },
              },
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(payloads).toHaveLength(3);
    const input = JSON.stringify(payloads[0].input);
    expect(input).toContain("理解当前用户的问题和会话中已经确认的条件");
    expect(input).toContain("将业务问题转换为 API 工具可接收的结构化查询 DSL");
    const reference = skills.readReference("query-dsl", "references/relational-query.md");
    const aggregation = skills.readReference("query-dsl", "references/pre-aggregation.md");
    const contents = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(contents)
          : [];
    expect(contents(payloads[0].input).some((text) => text.includes(reference.content))).toBe(
      false,
    );
    const loaded = contents(payloads[1].input).flatMap((text) => {
      try {
        return [JSON.parse(text) as unknown];
      } catch {
        return [];
      }
    });
    expect(loaded).toContainEqual(reference);
    expect(loaded).not.toContainEqual(aggregation);
    expect(contents(payloads[1].input).some((text) => text.includes(aggregation.content))).toBe(
      false,
    );
    expect(
      await readFile(
        join(directory, "home/skills/query-dsl/references/relational-query.md"),
        "utf8",
      ),
    ).toBe(reference.content);
    expect(audit).toHaveBeenLastCalledWith(
      context,
      "run",
      expect.anything(),
      expect.objectContaining({ tool_name: "read_skill_reference", status: "completed" }),
    );
    expect(payloads[0].tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "function", name: "query_count" })]),
    );
    expect(JSON.stringify(payloads[2].input)).toContain("对象不支持参数化查询");
    expect(JSON.stringify(payloads[2].input)).toContain("UNSUPPORTED_QUERY");
  } finally {
    await harness?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal(dirname(directory), root, "测试目录超出项目范围");
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
