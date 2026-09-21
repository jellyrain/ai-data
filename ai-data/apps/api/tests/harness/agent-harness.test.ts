import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { SkillResources } from "../../src/skills/skill-resources";
import type { HarnessRequest, HarnessResult } from "../../src/harness/harness-types";

const parent = resolve("secrets");
const directories: string[] = [];
const harnesses: CodexAnalysisHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  for (const path of directories.splice(0)) {
    expect(dirname(path)).toBe(parent);
    await rm(path, { recursive: true, force: true });
  }
});
function details(result: HarnessResult) {
  if (result.status !== "completed") throw new Error("expected completion");
  return JSON.parse(result.content);
}
async function setup() {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "agent-harness-"));
  directories.push(root);
  const harness = new CodexAnalysisHarness(
    {
      stateDirectory: root,
      timeoutMs: 10000,
    },
    {
      command: {
        executable: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/agent-app-server.mjs", import.meta.url))],
      },
    },
  );
  harnesses.push(harness);
  const request = async (name: string): Promise<HarnessRequest> => {
    const cwd = join(root, name),
      directory = join(cwd, ".agents/skills");
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(
      join(directory, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\n${name}`,
    );
    return {
      sessionKey: name,
      input: "执行",
      instructions: name,
      signal: new AbortController().signal,
      onThreadStarted: async () => {},
      tools: [
        { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
      ],
      executeTool: async (_name, input) => ({ success: true, output: input }),
      configuration: {
        provider: {
          id: name,
          baseUrl: `http://localhost/${name}`,
          model: name,
          apiKey: `test-${name}`,
        },
        cwd,
        skills: new SkillResources(directory, [name]),
        timeoutMs: 10000,
        contextWindow: 32768,
      },
    };
  };
  return { harness, request };
}
it("运行必须绑定模型，缺失配置的请求失败后仍可执行有效请求", async () => {
  const { harness, request } = await setup();
  const configured = await request("agent-a");
  await harness.start();
  await expect(harness.run({ ...configured, configuration: undefined })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect(details(await harness.run(configured)).settings.model).toBe("agent-a");
});
it("两个 Agent 在共用进程中装配各自模型、认证和独立 Skill，恢复时重传配置", async () => {
  const { harness, request } = await setup();
  await harness.start();
  const a = await request("agent-a"),
    b = await request("agent-b");
  await harness.run(a);
  await harness.run(b);
  const [ra, rb] = (await Promise.all([harness.run(a), harness.run(b)])).map(details);
  expect(ra.pid).toBe(rb.pid);
  expect(ra.apiKey).toBe("test-agent-a");
  expect(rb.apiKey).toBe("test-agent-b");
  expect(ra.settings.model).toBe("agent-a");
  expect(rb.settings.model).toBe("agent-b");
  expect(ra.skills.map((s: { name: string }) => s.name)).toEqual(["agent-a"]);
  expect(
    ra.settings.config["skills.config"].find((s: { path: string }) => s.path.includes("unbound"))
      .enabled,
  ).toBe(false);
  const resumed = details(
    await harness.run({ ...a, threadId: ra.settings.threadId ?? "saved-thread" }),
  );
  expect(resumed.settings.model).toBe("agent-a");
  expect(resumed.settings.cwd).toBe(a.configuration!.cwd);
  expect(resumed.skills).toEqual([]);
});
it("新增认证等待在途运行结束后重建，等待期间取消不会开始模型轮次", async () => {
  const { harness, request } = await setup();
  const a = await request("agent-a"),
    b = await request("agent-b");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const running = harness.run({
    ...a,
    executeTool: async (_name, value) => {
      entered();
      await held;
      return { success: true, output: value };
    },
  });
  await ready;
  const controller = new AbortController();
  const waiting = harness.run({ ...b, signal: controller.signal });
  const cancelled = expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
  controller.abort();
  await cancelled;
  release();
  const first = details(await running);
  const second = details(await harness.run(b));
  expect(first.pid).not.toBe(second.pid);
});
