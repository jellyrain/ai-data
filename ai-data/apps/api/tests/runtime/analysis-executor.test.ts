import { describe, expect, it, vi } from "vitest";
import { AnalysisExecutor } from "../../src/runtime/analysis-executor";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";
import type { HarnessRequest, HarnessResult } from "../../src/harness/harness-types";

function setup() {
  const lease = { owner: "worker", epoch: 1, expires_at: "2026-09-14 23:00:00" };
  const runs = {
    claim: vi.fn(async () => lease),
    renew: vi.fn(async () => lease),
    complete: vi.fn(async () => ({})),
    fail: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    attachController: vi.fn(() => () => {}),
    release: vi.fn(async () => {}),
    assertCurrent: vi.fn(async () => {}),
    get: vi.fn(async () => ({})),
    evidence: vi.fn(async () => []),
    recordCompaction: vi.fn(async () => {}),
  };
  const harness = {
    run: vi.fn<(request: HarnessRequest) => Promise<HarnessResult>>(async () => ({
      status: "completed",
      content: "共 2 人次。",
    })),
  };
  const tools = {
    definitions: () => [],
    execute: vi.fn(async () => ({ success: true, output: {} })),
  };
  const repository = {
    loadInput: vi.fn(async () => ({
      conversation_id: "conversation",
      context_hash: "scope-hash",
      thread_id: "saved-thread",
      messages: [{ role: "user", content: "本月就诊人次" }],
      run_ids: [] as string[],
    })),
    saveThread: vi.fn(async () => {}),
  };
  const executor = new AnalysisExecutor({
    runs,
    harness,
    tools,
    repository,
    refreshContext: async () => context,
    instructions: "查询分析",
    heartbeatMs: 1000,
  } as unknown as ConstructorParameters<typeof AnalysisExecutor>[0]);
  return { runs, harness, tools, repository, executor };
}

describe("分析执行器", () => {
  it("把压缩事件绑定当前业务身份、运行和租约", async () => {
    const h = setup();
    h.harness.run.mockImplementation(async (request) => {
      await request.onCompaction!({ itemId: "compact-1", status: "started" });
      return { status: "completed", content: "完成" };
    });
    await h.executor.execute(context, "run");
    expect(h.runs.recordCompaction).toHaveBeenCalledWith(
      context,
      "run",
      expect.objectContaining({ owner: "worker", epoch: 1 }),
      { itemId: "compact-1", status: "started" },
    );
  });
  it("历史证据授权已收回时拒绝恢复官方线程", async () => {
    const h = setup();
    const input = await h.repository.loadInput();
    h.repository.loadInput.mockResolvedValue({ ...input, run_ids: ["historical-run"] });
    h.runs.get.mockRejectedValue(new ApplicationError("POLICY_REJECTED", "历史证据权限已变化"));
    await h.executor.execute(context, "run");
    expect(h.harness.run).not.toHaveBeenCalled();
    expect(h.runs.fail).toHaveBeenCalledWith(
      context,
      "run",
      expect.anything(),
      expect.objectContaining({ code: "POLICY_REJECTED" }),
    );
  });
  it("模型完成前授权范围发生变化时拒绝交付旧范围答案", async () => {
    const h = setup();
    const input = await h.repository.loadInput();
    h.repository.loadInput
      .mockResolvedValueOnce(input)
      .mockResolvedValue({ ...input, context_hash: "changed-scope" });
    await h.executor.execute(context, "run");
    expect(h.harness.run).toHaveBeenCalledOnce();
    expect(h.runs.complete).not.toHaveBeenCalled();
    expect(h.runs.fail).toHaveBeenCalledWith(
      context,
      "run",
      expect.anything(),
      expect.objectContaining({ code: "POLICY_REJECTED" }),
    );
  });
  it("按业务会话恢复官方线程，并以当前租约保存新线程标识", async () => {
    const h = setup();
    h.harness.run.mockImplementation(async (input) => {
      expect(input.threadId).toBe("saved-thread");
      expect(input.sessionKey).toContain("conversation");
      await input.onThreadStarted("official-thread");
      return { status: "completed", content: "完成" };
    });
    await h.executor.execute(context, "run");
    expect(h.repository.saveThread).toHaveBeenCalledWith(
      context,
      "run",
      expect.anything(),
      "scope-hash",
      "official-thread",
    );
    expect(h.runs.complete).toHaveBeenCalledOnce();
  });
  it("持有同一租约推进多个工具调用，最后只提交一次助手终态", async () => {
    const h = setup();
    h.harness.run.mockImplementation(async (input) => {
      await input.executeTool("list_datasets", {}, "first");
      await input.executeTool("query_dataset", {}, "second");
      expect(h.runs.complete).not.toHaveBeenCalled();
      return { status: "completed", content: "共 2 人次。" };
    });
    await h.executor.execute(context, "run");
    expect(h.runs.claim).toHaveBeenCalledOnce();
    expect(h.tools.execute).toHaveBeenCalledTimes(2);
    expect(h.runs.complete).toHaveBeenCalledWith(context, "run", expect.anything(), "共 2 人次。");
  });
  it("澄清暂停保留待答状态，不提交完成消息", async () => {
    const h = setup();
    h.harness.run.mockResolvedValue({ status: "waiting_clarification" } as never);
    await h.executor.execute(context, "run");
    expect(h.runs.complete).not.toHaveBeenCalled();
    expect(h.runs.fail).not.toHaveBeenCalled();
  });
  it("模型服务异常后保存稳定失败状态", async () => {
    const h = setup();
    h.harness.run.mockRejectedValue(new Error("model unavailable"));
    await h.executor.execute(context, "run");
    expect(h.runs.fail).toHaveBeenCalledOnce();
    expect(h.runs.complete).not.toHaveBeenCalled();
  });
  it("同一进程重复派发同一个运行共用执行 Promise", async () => {
    const h = setup();
    await Promise.all([h.executor.execute(context, "run"), h.executor.execute(context, "run")]);
    expect(h.harness.run).toHaveBeenCalledOnce();
  });
});
