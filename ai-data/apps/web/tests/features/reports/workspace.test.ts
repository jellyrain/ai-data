import { describe, it, expect, vi } from "vitest";
import { ReportWorkspace } from "../../../src/features/reports/stores/report-workspace";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";
import { definition, execution } from "./fixtures";

function setup() {
  const resources = new SessionResources();
  const request = vi.fn<Transport>(async (path) => {
    if (path.includes("/definition?")) return definition;
    if (path.endsWith("/versions"))
      return { definitions: [definition], snapshots: [execution.snapshot] };
    if (path.includes("/report-executions/")) return execution;
    if (path.startsWith("/api/reports/report?")) return execution.snapshot;
    throw new Error(path);
  });
  const workspace = new ReportWorkspace({
    request,
    resources,
    identity: () => ({ userId: "user", organizationId: "org" }),
  });
  return { workspace, request, resources };
}
describe("报表执行与页面生命周期", () => {
  it("游标页合并去重，失败重试保留已加载报表", async () => {
    const h = setup();
    const summary = {
      report_id: "a",
      title: "报表",
      user_id: "user",
      created_at: definition.created_at,
      shared_with: [],
    };
    h.request
      .mockResolvedValueOnce({ items: [summary], next_cursor: "a" })
      .mockRejectedValueOnce(new ApiError("读取失败"))
      .mockResolvedValueOnce({ items: [summary, { ...summary, report_id: "b" }] });
    await h.workspace.list();
    await h.workspace.list(true);
    expect(h.workspace.state.items).toHaveLength(1);
    expect(h.workspace.state.listError).toContain("读取失败");
    await h.workspace.list(true);
    expect(h.workspace.state.items.map((item) => item.report_id)).toEqual(["a", "b"]);
    expect(h.request.mock.calls.at(-1)?.[0]).toContain("cursor=a");
    h.workspace.dispose();
  });
  it("定义读取失败仍展示已有结果，定义版本切换不发起执行", async () => {
    const h = setup(),
      request = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (path, options) => {
      if (path.includes("/definition?")) throw new ApiError("定义暂不可用", 500);
      return request(path, options);
    });
    await h.workspace.open("report");
    expect(h.workspace.state.definitionError).toContain("定义暂不可用");
    expect(h.workspace.state.snapshot?.version).toBe(1);
    h.request.mockResolvedValueOnce({ ...definition, version: 2 });
    await h.workspace.selectDefinition(2);
    expect(h.workspace.state.definition?.version).toBe(2);
    expect(h.workspace.state.displayExecution?.definition_version).toBe(1);
    expect(h.request.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
    h.workspace.dispose();
  });
  it("快速切换执行会中止旧请求并忽略其迟到结果", async () => {
    const h = setup();
    await h.workspace.open("report");
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = h.workspace.selectExecution("old");
    const signal = h.request.mock.calls.at(-1)?.[1]?.signal;
    await h.workspace.selectExecution("execution");
    release({
      ...execution,
      execution_id: "old",
      snapshot: { ...execution.snapshot, execution_id: "old" },
    });
    await first;
    expect(signal?.aborted).toBe(true);
    expect(h.workspace.state.displayExecution?.execution_id).toBe("execution");
    h.workspace.dispose();
  });
  it("重复点击只提交一次，切页后晚到执行回执不能恢复数据", async () => {
    const h = setup();
    await h.workspace.open("report");
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const count = h.request.mock.calls.length,
      first = h.workspace.execute({ min: 0 });
    await h.workspace.execute({ min: 0 });
    expect(h.request.mock.calls.length).toBe(count + 1);
    h.workspace.leave();
    release(execution);
    await first;
    expect(h.workspace.state.snapshot).toBeNull();
    h.workspace.dispose();
  });
  it("已知运行仅有限轮询，离页释放计时器", async () => {
    vi.useFakeTimers();
    const h = setup();
    try {
      const request = h.request.getMockImplementation()!;
      h.request.mockImplementation(async (path, options) =>
        path.includes("/report-executions/")
          ? { ...execution, status: "running", results: [], snapshot: undefined }
          : request(path, options),
      );
      await h.workspace.open("report", "execution");
      const before = h.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.request.mock.calls.length - before).toBe(10);
      await h.workspace.refreshExecution();
      expect(h.request.mock.calls.length - before).toBe(11);
      h.workspace.leave();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.workspace.dispose();
      vi.useRealTimers();
    }
  });
  it("打开与恢复只读取记录，定义选择和已保存条件分别持有", async () => {
    const h = setup();
    await h.workspace.open("report", "execution");
    expect(h.workspace.state.displayExecution?.parameters).toEqual({ min: 0 });
    expect(
      h.request.mock.calls.every(([, options]) => !options?.method || options.method === "GET"),
    ).toBe(true);
    h.workspace.dispose();
  });
  it("回执丢失后相同输入沿用幂等键，修改参数才更换键", async () => {
    const h = setup();
    await h.workspace.open("report");
    const bodies: unknown[] = [];
    h.request.mockImplementation(async (_path, options) => {
      bodies.push(options?.body);
      throw new ApiError("连接中断");
    });
    await h.workspace.execute({ min: 0 });
    await h.workspace.execute({ min: 0 });
    await h.workspace.execute({ min: 1 });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[2]).not.toEqual(bodies[1]);
    expect(h.workspace.state.snapshot?.version).toBe(1);
    expect(h.request.mock.calls.at(-1)?.[1]?.timeoutMs).toBe(150_000);
    h.workspace.dispose();
  });
  it("执行失败保留原成功结果，权限拒绝则清空受限内容", async () => {
    const h = setup();
    await h.workspace.open("report", "execution");
    h.request.mockResolvedValueOnce({
      ...execution,
      execution_id: "failed",
      status: "failed",
      results: [],
      snapshot: undefined,
      error_code: "QUERY_TIMEOUT",
    });
    await h.workspace.execute({});
    expect(h.workspace.state.execution?.status).toBe("failed");
    expect(h.workspace.state.displayExecution?.execution_id).toBe("execution");
    h.request.mockRejectedValueOnce(new ApiError("权限已收窄", 403));
    await h.workspace.refreshExecution();
    expect(h.workspace.state.snapshot).toBeNull();
    expect(h.workspace.state.displayExecution).toBeNull();
    h.workspace.dispose();
  });
  it("身份清理后迟到的打开结果不能恢复页面数据", async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const opening = h.workspace.open("report");
    h.resources.reset();
    resolve({ definitions: [definition], snapshots: [] });
    await opening;
    expect(h.workspace.state.definition).toBeNull();
    expect(h.workspace.state.reportId).toBe("");
    h.workspace.dispose();
  });
});
