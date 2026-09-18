import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import type { HarnessRequest } from "../../src/harness/harness-types";
import { ApplicationError } from "../../src/errors/application-error";

const directories: string[] = [];
const testRoot = resolve("secrets");
const harnesses: CodexAnalysisHarness[] = [];
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(
    directories.splice(0).map((path) => {
      if (dirname(path) !== testRoot) throw new Error("测试目录超出项目范围");
      return rm(path, { recursive: true, force: true });
    }),
  );
});
async function setup(mode = "complete", timeoutMs = 3000) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "ai-data-harness-test-"));
  directories.push(directory);
  const harness = new CodexAnalysisHarness(
    {
      provider: {
        id: "local",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "configured-model",
        apiKey: "test-key",
      },
      stateDirectory: directory,
      timeoutMs,
    },
    {
      command: {
        executable: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url)), mode],
      },
    },
  );
  harnesses.push(harness);
  const controller = new AbortController();
  const request: HarnessRequest = {
    sessionKey: "org:user:conversation",
    input: "查询人数",
    instructions: "按授权证据回答",
    signal: controller.signal,
    onThreadStarted: vi.fn(async () => {}),
    tools: [
      {
        name: "query_count",
        description: "查询授权人数",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    executeTool: vi.fn(async () => ({ success: true, output: { count: 7 } })),
  };
  return { harness, request, controller, directory };
}
describe("官方 Codex app-server 接入", () => {
  it("两个工具同时在途时取消其中一个，另一个仍按所属会话交付", async () => {
    const h = await setup("multiple");
    const firstEntered = signal();
    const secondEntered = signal();
    const firstRelease = signal();
    const secondRelease = signal();
    const first = h.harness.run({
      ...h.request,
      executeTool: async () => {
        firstEntered.resolve();
        await firstRelease.promise;
        return { success: true, output: "first" };
      },
    });
    const cancelled = expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    await firstEntered.promise;
    const second = h.harness.run({
      ...h.request,
      sessionKey: "second",
      signal: new AbortController().signal,
      executeTool: async () => {
        secondEntered.resolve();
        await secondRelease.promise;
        return { success: true, output: "second" };
      },
    });
    await secondEntered.promise;
    h.controller.abort();
    await cancelled;
    firstRelease.resolve();
    secondRelease.resolve();
    await expect(second).resolves.toEqual({ status: "completed", content: '"second"' });
  });
  it("注册普通函数，保存官方会话标识，执行函数并根据完成事件交付", async () => {
    const h = await setup();
    await expect(h.harness.run(h.request)).resolves.toEqual({
      status: "completed",
      content: '{"count":7}',
    });
    expect(h.request.onThreadStarted).toHaveBeenCalledWith("thread-test");
    expect(h.request.executeTool).toHaveBeenCalledWith("query_count", {}, "call-1");
  });
  it("恢复持久化会话时继续使用官方保存的工具", async () => {
    const h = await setup("resume");
    await expect(h.harness.run({ ...h.request, threadId: "thread-saved" })).resolves.toMatchObject({
      status: "completed",
    });
    expect(h.request.onThreadStarted).toHaveBeenCalledWith("thread-saved");
  });
  it("澄清提交后中断本轮且不提交完成答案", async () => {
    const h = await setup();
    h.request.executeTool = vi.fn(async () => ({
      success: true,
      output: { question: "月份" },
      stop: true,
    }));
    await expect(h.harness.run(h.request)).resolves.toEqual({ status: "waiting_clarification" });
    expect(h.request.executeTool).toHaveBeenCalledOnce();
  });
  it("认证失效中断工具调用，公开结果不包含内部异常", async () => {
    const h = await setup();
    h.request.executeTool = vi.fn(async () => {
      throw new ApplicationError("AUTHENTICATION_FAILED", "sensitive response");
    });
    await expect(h.harness.run(h.request)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "分析工具执行失败",
    });
  });
  it.each(["unknown-tool", "wrong-thread", "duplicate-call"])("拒绝 %s 工具请求", async (mode) => {
    const h = await setup(mode);
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(vi.mocked(h.request.executeTool).mock.calls.length).toBeLessThanOrEqual(
      mode === "duplicate-call" ? 1 : 0,
    );
  });
  it("超时停止无响应的轮次", async () => {
    const h = await setup("hang", 200);
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
  });
  it("用户取消后停止在途轮次", async () => {
    const h = await setup("hang");
    h.request.onThreadStarted = async () => {
      h.controller.abort();
    };
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it.each(["exit", "partial", "init-error"])("%s 不会被当作完成结果", async (mode) => {
    const h = await setup(mode);
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
  it("会话映射保存失败时不开始模型轮次", async () => {
    const h = await setup();
    h.request.onThreadStarted = async () => {
      throw new ApplicationError("CONFLICT", "租约过期");
    };
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.request.executeTool).not.toHaveBeenCalled();
  });
  it("并发和追问复用进程，工具和结果按会话分发", async () => {
    const h = await setup("multiple");
    const assigned = new Map<string, string>();
    const invoke = (sessionKey: string, threadId?: string) =>
      h.harness.run({
        ...h.request,
        sessionKey,
        threadId,
        onThreadStarted: async (id) => {
          assigned.set(sessionKey, id);
        },
        executeTool: async (_name, value) => ({ success: true, output: value }),
      });
    const first = await invoke("a");
    const second = await invoke("b");
    const resumed = await invoke("a", "thread-test");
    const details = [first, second, resumed].map((result) =>
      JSON.parse((result as { content: string }).content),
    );
    expect(new Set(details.map((item) => item.pid)).size).toBe(1);
    expect(details.map((item) => item.threadId)).toEqual([
      "thread-test",
      "thread-2",
      "thread-test",
    ]);
    expect(details.every((item) => item.initializations === 1)).toBe(true);
    const concurrent = await Promise.all([invoke("c"), invoke("d")]);
    expect(
      concurrent.map((result) => JSON.parse((result as { content: string }).content).threadId),
    ).toEqual([assigned.get("c"), assigned.get("d")]);
    expect(assigned.get("c")).not.toBe(assigned.get("d"));
    expect(details[0].home).toBe(join(h.directory, "home"));
    expect(details[0].temp).toBe(join(h.directory, "tmp"));
    expect(details[0].log).toBe(join(h.directory, "logs"));
  });
  it("取消一个会话保留其他会话和常驻进程", async () => {
    const h = await setup("multiple");
    const entered = signal();
    const pending = h.harness.run({
      ...h.request,
      input: "hold",
      onThreadStarted: async () => entered.resolve(),
    });
    const cancelled = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await entered.promise;
    const other = await h.harness.run({
      ...h.request,
      sessionKey: "other",
      executeTool: async (_name, value) => ({ success: true, output: value }),
    });
    h.controller.abort();
    await cancelled;
    const next = await h.harness.run({
      ...h.request,
      signal: new AbortController().signal,
      threadId: "thread-test",
      executeTool: async (_name, value) => ({ success: true, output: value }),
    });
    expect(JSON.parse((next as { content: string }).content).pid).toBe(
      JSON.parse((other as { content: string }).content).pid,
    );
  });
  it("进程退出使在途运行失败，后续并发请求统一重建", async () => {
    const h = await setup("multiple");
    const entered = signal();
    const held = h.harness.run({
      ...h.request,
      input: "hold",
      onThreadStarted: async () => entered.resolve(),
    });
    const failedHeld = expect(held).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await entered.promise;
    await expect(
      h.harness.run({ ...h.request, sessionKey: "crasher", input: "crash" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await failedHeld;
    const results = await Promise.all(
      ["next-a", "next-b"].map((sessionKey) =>
        h.harness.run({
          ...h.request,
          sessionKey,
          executeTool: async (_name, value) => ({ success: true, output: value }),
        }),
      ),
    );
    const details = results.map((result) => JSON.parse((result as { content: string }).content));
    expect(details[0].pid).toBe(details[1].pid);
    expect(details.every((item) => item.initializations === 1)).toBe(true);
  });
  it("同一会话拒绝重叠执行，关闭服务释放在途任务", async () => {
    const h = await setup("multiple");
    const entered = signal();
    const pending = h.harness.run({
      ...h.request,
      input: "hold",
      onThreadStarted: async () => entered.resolve(),
    });
    const cancelled = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await entered.promise;
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "CONFLICT" });
    await h.harness.close();
    await cancelled;
    await expect(h.harness.run(h.request)).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("压缩开始和完成按顺序交付，持久化完成后才返回答案", async () => {
    const h = await setup("multiple");
    const events: unknown[] = [];
    await expect(
      h.harness.run({
        ...h.request,
        input: "compact",
        onCompaction: async (event) => {
          events.push(event);
        },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(events).toEqual([
      { itemId: "compact-1", status: "started" },
      { itemId: "compact-1", status: "completed" },
    ]);
  });
  it("取消发生在轮次响应之前也会终止该轮，随后可以恢复同一线程", async () => {
    const h = await setup("multiple");
    await expect(
      h.harness.run({
        ...h.request,
        input: "delayed-turn",
        onThreadStarted: async () => {
          setTimeout(() => h.controller.abort(), 30);
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      h.harness.run({
        ...h.request,
        threadId: "thread-test",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });
  it("压缩持久化失败仅结束所属运行，下一次执行仍可使用该进程", async () => {
    const h = await setup("multiple");
    await expect(
      h.harness.run({
        ...h.request,
        input: "compact",
        onCompaction: async () => {
          throw new ApplicationError("CONFLICT", "租约已失效");
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(h.harness.run({ ...h.request, threadId: "thread-test" })).resolves.toMatchObject({
      status: "completed",
    });
  });
});
