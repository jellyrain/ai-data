import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { SkillSnapshotStore } from "../../src/skills/skill-snapshot-store";
import type { HarnessConfiguration, HarnessRequest } from "../../src/harness/harness-types";

it("官方进程按线程选择模型认证与 Skill，恢复旧线程保持原资源且不重复注入入口", async () => {
  const received: { body: Record<string, unknown>; authorization?: string; header?: string }[] = [];
  let concurrent = false;
  const arrivals: (() => void)[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    received.push({
      body: JSON.parse(body),
      authorization: request.headers.authorization,
      header: String(request.headers["x-agent"]),
    });
    // 两个请求都到达后才返回，验证同一常驻进程允许不同 Agent 同时生成。
    if (concurrent)
      await new Promise<void>((done) => {
        arrivals.push(done);
        if (arrivals.length === 2) arrivals.forEach((resolve) => resolve());
      });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = {
      id: `message-${received.length}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "完成", annotations: [] }],
    };
    const emit = (type: string, fields: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", {
      response: { id: `response-${received.length}`, status: "in_progress", output: [] },
    });
    emit("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
    emit("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "完成",
    });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id: `response-${received.length}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 },
      },
    });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试监听失败");
  const root = resolve("secrets");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "agent-protocol-"));
  const source = join(directory, "source");
  const createSkill = async (name: string, content: string) => {
    await mkdir(join(source, name), { recursive: true });
    await writeFile(
      join(source, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: 测试 ${name}\n---\n${content}\n`,
    );
  };
  let harness: CodexAnalysisHarness | undefined;
  try {
    await createSkill("alpha", "ALPHA_BODY_MARKER");
    await createSkill("beta", "BETA_BODY_MARKER");
    const snapshots = new SkillSnapshotStore({
      sourceDirectory: source,
      stateDirectory: directory,
    });
    const a = await snapshots.prepare("org", "a", 1, ["alpha"]),
      b = await snapshots.prepare("org", "b", 1, ["beta"]);
    const provider = {
      id: "alpha",
      model: "model-a",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "key-a",
      headers: { "X-Agent": "header-a" },
    };
    const configA: HarnessConfiguration = {
      provider,
      cwd: a.cwd,
      skills: a.skills,
      timeoutMs: 15000,
      contextWindow: 32768,
    };
    const configB: HarnessConfiguration = {
      ...configA,
      provider: {
        ...provider,
        id: "beta",
        model: "model-b",
        apiKey: "key-b",
        headers: { "X-Agent": "header-b" },
      },
      cwd: b.cwd,
      skills: b.skills,
    };
    const options = { stateDirectory: directory, timeoutMs: 15000 };
    harness = new CodexAnalysisHarness(options);
    await harness.start();
    const threads: string[] = [];
    const request = (configuration: HarnessConfiguration, threadId?: string): HarnessRequest => ({
      configuration,
      threadId,
      sessionKey: configuration.provider.id,
      input: "回答完成",
      instructions: "测试指令",
      tools: [
        {
          name: `tool_${configuration.provider.id}`,
          description: "测试业务函数",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      signal: new AbortController().signal,
      onThreadStarted: async (id) => {
        threads.push(id);
      },
      executeTool: async () => ({ success: true, output: {} }),
    });
    expect(await harness.run(request(configA))).toMatchObject({
      status: "completed",
      content: "完成",
    });
    expect(await harness.run(request(configB))).toMatchObject({ status: "completed" });
    concurrent = true;
    const parallel = await Promise.all([
      harness.run(request(configA)),
      harness.run(request(configB)),
    ]);
    concurrent = false;
    expect(parallel.every((result) => result.status === "completed")).toBe(true);
    expect(arrivals).toHaveLength(2);
    expect(new Set(threads).size).toBe(4);
    await createSkill("new-source", "NEW_SOURCE_MARKER");
    await harness.close();
    harness = new CodexAnalysisHarness(options);
    expect(await harness.run(request(configA, threads[0]))).toMatchObject({ status: "completed" });
    expect(threads[4]).toBe(threads[0]);
    expect(received).toHaveLength(5);
    expect(
      [received[0], received[1], received[4]].map((item) => [
        item.body.model,
        item.authorization,
        item.header,
      ]),
    ).toEqual([
      ["model-a", "Bearer key-a", "header-a"],
      ["model-b", "Bearer key-b", "header-b"],
      ["model-a", "Bearer key-a", "header-a"],
    ]);
    for (const index of [0, 4]) {
      const input = JSON.stringify(received[index].body.input);
      expect(input.match(/ALPHA_BODY_MARKER/g)).toHaveLength(1);
      expect(input).not.toContain("BETA_BODY_MARKER");
      expect(input).not.toContain("NEW_SOURCE_MARKER");
      expect(input).not.toContain("skill-creator");
    }
    expect(JSON.stringify(received[1].body.input)).toContain("BETA_BODY_MARKER");
    expect(JSON.stringify(received[1].body.input)).not.toContain("ALPHA_BODY_MARKER");
    expect(JSON.stringify(received[0].body.tools)).toContain("tool_alpha");
    expect(JSON.stringify(received[0].body.tools)).not.toContain("tool_beta");
    const empty = await snapshots.prepare("org", "empty", 1, []);
    const emptyRequest = request({ ...configA, cwd: empty.cwd, skills: empty.skills });
    expect(await harness.run({ ...emptyRequest, tools: [] })).toMatchObject({
      status: "completed",
    });
    expect(JSON.stringify(received[5].body.input)).not.toContain("ALPHA_BODY_MARKER");
    expect(JSON.stringify(received[5].body.tools)).not.toContain("tool_alpha");
  } finally {
    await harness?.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    assert.equal(dirname(directory), root);
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);
