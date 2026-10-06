import { describe, it, expect, vi } from "vitest";
import { ReportRevisions } from "../../../src/features/reports/stores/report-revisions";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";
import type { AnalysisRunState, SseEvent } from "@ai-data/contracts";
import { projectRunTimeline } from "../../../src/features/analysis/stores/run-timeline";
function run(status: AnalysisRunState["status"]): AnalysisRunState {
  return {
    analysis_run_id: "run",
    conversation_id: "conversation",
    user_id: "user",
    organization_id: "org",
    status,
    sequence: 0,
    created_at: "2026-09-28 08:00:00",
    updated_at: "2026-09-28 08:01:00",
    lease_epoch: 1,
    lease: null,
    clarification: null,
    evidence_ids: [],
    error: null,
  };
}
function setup() {
  const request = vi.fn<Transport>(async () => {
    throw new ApiError("连接中断");
  });
  const resources = new SessionResources(),
    lock = vi.fn(),
    commit = vi.fn(async () => {});
  const stream = vi.fn();
  const store = new ReportRevisions({
    request,
    resources,
    identity: () => ({ userId: "user", organizationId: "org" }),
    stream,
    lock,
    commit,
  });
  store.select("report");
  return { request, resources, store, lock, commit, stream };
}
describe("AI 修改固定定义版本", () => {
  it("恢复已完成修改时回放增量和工具，成功后读取版本并在离开时清空", async () => {
    const h = setup();
    const base = { analysis_run_id: "run", conversation_id: "conversation", lease_epoch: 1 };
    const events: SseEvent[] = [
      {
        ...base,
        sequence: 1,
        type: "assistant_message",
        message_id: "m",
        status: "delta",
        content: "调整",
      },
      {
        ...base,
        sequence: 2,
        type: "tool_call",
        tool_call_id: "t",
        tool_name: "save_report_definition",
        input_summary: "保存定义",
      },
      {
        ...base,
        sequence: 3,
        type: "tool_result",
        tool_call_id: "t",
        tool_name: "save_report_definition",
        success: true,
        output_summary: "已保存",
      },
      { ...base, sequence: 4, type: "final_answer", message_id: "m", content: "调整完成" },
      { ...base, sequence: 5, type: "run_completed" },
    ];
    h.request
      .mockResolvedValueOnce({ report_id: "report", analysis_run_id: "run", expected_version: 2 })
      .mockResolvedValue({ ...run("completed"), sequence: 5 });
    h.stream.mockResolvedValue(
      new Response(
        events
          .map(
            (event) =>
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    await h.store.restore("run");
    await vi.waitFor(() => expect(h.store.state.committed).toBe(true));
    expect(projectRunTimeline(h.store.state.events)).toMatchObject([
      { kind: "message", content: "调整完成", final: true },
      { kind: "tool", success: true },
    ]);
    expect(h.commit).toHaveBeenCalledExactlyOnceWith(3);
    h.resources.reset();
    expect(h.store.state.events).toEqual([]);
    h.store.dispose();
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "刷新恢复 %s 先读取绑定，只有成功替换为实际版本",
    async (status) => {
      const h = setup();
      h.request
        .mockResolvedValueOnce({ report_id: "report", analysis_run_id: "run", expected_version: 2 })
        .mockResolvedValue(run(status));
      await h.store.restore("run");
      await vi.waitFor(() => expect(h.lock).toHaveBeenLastCalledWith(false));
      expect(h.request.mock.calls[0]?.[0]).toBe("/api/reports/report/revisions/run");
      expect(h.request.mock.calls[1]?.[0]).toBe("/api/analysis-runs/run");
      expect(
        h.request.mock.calls.every(([, options]) => !options?.method || options.method === "GET"),
      ).toBe(true);
      expect(h.store.state.version).toBe(2);
      if (status === "completed") expect(h.commit).toHaveBeenCalledExactlyOnceWith(3);
      else expect(h.commit).not.toHaveBeenCalled();
      h.store.dispose();
    },
  );
  it("拒绝另一报表绑定，不读取该任务；读取失败可以原地只读重试", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({
      report_id: "other",
      analysis_run_id: "run",
      expected_version: 2,
    });
    await h.store.restore("run");
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.store.state.receipt).toBeNull();
    expect(h.commit).not.toHaveBeenCalled();
    h.store.select("report");
    await h.store.restore("run");
    expect(h.lock).toHaveBeenLastCalledWith(true);
    const count = h.request.mock.calls.length;
    await h.store.start(3, "不能创建新任务");
    expect(h.request).toHaveBeenCalledTimes(count);
    h.request
      .mockResolvedValueOnce({ report_id: "report", analysis_run_id: "run", expected_version: 2 })
      .mockResolvedValue(run("cancelled"));
    await h.store.restore("run");
    await vi.waitFor(() => expect(h.lock).toHaveBeenLastCalledWith(false));
    h.store.dispose();
  });
  it("运行身份不匹配或切换账号后的晚到绑定不能写回", async () => {
    const h = setup();
    h.request
      .mockResolvedValueOnce({ report_id: "report", analysis_run_id: "run", expected_version: 2 })
      .mockResolvedValueOnce({ ...run("completed"), user_id: "other" });
    await h.store.restore("run");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.store.state.receipt).toBeNull();
    h.store.select("report");
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const pending = h.store.restore("run");
    h.resources.reset();
    release({ report_id: "report", analysis_run_id: "run", expected_version: 2 });
    await pending;
    expect(h.store.state.receipt).toBeNull();
    expect(h.store.state.reportId).toBe("");
    h.store.dispose();
  });
  it("恢复途中切换任务链接，晚到的旧绑定不能覆盖新任务", async () => {
    const h = setup();
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const pending = h.store.restore("old-run");
    h.request
      .mockResolvedValueOnce({ report_id: "report", analysis_run_id: "run", expected_version: 2 })
      .mockResolvedValue(run("completed"));
    await h.store.restore("run");
    expect(h.store.state.receipt?.analysis_run_id).toBe("run");
    release({ report_id: "report", analysis_run_id: "old-run", expected_version: 1 });
    await pending;
    await vi.waitFor(() => expect(h.commit).toHaveBeenCalledExactlyOnceWith(3));
    expect(h.store.state.receipt?.analysis_run_id).toBe("run");
    expect(h.request.mock.calls.some(([url]) => url === "/api/analysis-runs/old-run")).toBe(false);
    h.store.dispose();
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "运行终态 %s 只在成功时读取基准版本加一",
    async (status) => {
      const h = setup();
      h.request
        .mockResolvedValueOnce({ analysis_run_id: "run", conversation_id: "conversation" })
        .mockResolvedValue({
          analysis_run_id: "run",
          conversation_id: "conversation",
          user_id: "user",
          organization_id: "org",
          status,
          sequence: 0,
          created_at: "2026-09-28 08:00:00",
          updated_at: "2026-09-28 08:01:00",
          lease_epoch: 1,
          lease: null,
          clarification: null,
          evidence_ids: [],
          error: null,
        });
      await h.store.start(2, "修改标题");
      await vi.waitFor(() => expect(h.lock).toHaveBeenLastCalledWith(false));
      if (status === "completed") {
        expect(h.commit).toHaveBeenCalledExactlyOnceWith(3);
        expect(h.store.state.committed).toBe(true);
      } else {
        expect(h.commit).not.toHaveBeenCalled();
        expect(h.store.state.committed).toBe(false);
      }
      h.store.dispose();
    },
  );
  it("请求结果待确认时锁定定义，只允许同一版本同一输入复用原操作键", async () => {
    const h = setup();
    await h.store.start(2, "增加一个图表", "agent");
    const body = h.request.mock.calls[0]?.[1]?.body;
    expect(body).toMatchObject({ expected_version: 2, prompt: "增加一个图表", agent_id: "agent" });
    expect(h.lock).toHaveBeenLastCalledWith(true);
    await h.store.start(2, "增加一个图表", "agent");
    expect(h.request.mock.calls[1]?.[1]?.body).toEqual(body);
    await h.store.start(3, "改标题", "agent");
    expect(h.request).toHaveBeenCalledTimes(2);
    h.store.dispose();
  });
  it("确定拒绝后解除锁定，切换身份后丢弃迟到回执", async () => {
    const h = setup();
    h.request.mockRejectedValueOnce(new ApiError("版本冲突", 409));
    await h.store.start(2, "修改");
    expect(h.lock).toHaveBeenLastCalledWith(false);
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const sending = h.store.start(2, "修改");
    h.resources.reset();
    release({ conversation_id: "conversation", analysis_run_id: "run" });
    await sending;
    expect(h.store.state.receipt).toBeNull();
    expect(h.commit).not.toHaveBeenCalled();
    h.store.dispose();
  });
});
