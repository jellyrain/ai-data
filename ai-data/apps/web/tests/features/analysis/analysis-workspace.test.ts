import { describe, expect, it, vi } from "vitest";
import { AnalysisWorkspace } from "../../../src/features/analysis/stores/analysis-workspace";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";
import type { AnalysisRunState } from "@ai-data/contracts";

const conversation = {
  id: "c",
  userId: "u",
  organizationId: "o",
  title: "门诊分析",
  status: "active",
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};
const receipt = {
  message: {
    id: "m",
    conversationId: "c",
    role: "user",
    content: "人次",
    sequence: 1,
    createdAt: conversation.createdAt,
  },
  analysisRun: {
    id: "r",
    conversationId: "c",
    userId: "u",
    organizationId: "o",
    status: "created",
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: conversation.createdAt,
  },
};
function fixture(extra?: Transport) {
  const request = vi.fn<Transport>(async (path, options) => {
    if (path === "/api/agents") return { items: [] };
    if (path === "/api/conversations") return { items: [conversation] };
    if (path === "/api/conversations/c") return { conversation, messages: [] };
    return extra?.(path, options);
  });
  const resources = new SessionResources();
  const stream = vi.fn();
  const workspace = new AnalysisWorkspace({
    request,
    resources,
    stream,
    identity: () => ({ userId: "u", organizationId: "o" }),
  });
  return { workspace, request, resources, stream };
}
describe("分析工作台交互与身份清理", () => {
  it("运行期间读到的依据在运行结束后重新读取，合并同时点击的请求", async () => {
    let snapshot: AnalysisRunState = {
      analysis_run_id: "r",
      conversation_id: "c",
      user_id: "u",
      organization_id: "o",
      status: "running",
      sequence: 0,
      created_at: "2026-09-27 08:00:00",
      updated_at: "2026-09-27 08:00:00",
      lease_epoch: 1,
      lease: null,
      clarification: null,
      evidence_ids: [],
      error: null,
    };
    const { workspace, request, stream } = fixture(async (path) =>
      path === "/api/analysis-runs/r" ? snapshot : { items: [] },
    );
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        feed = controller;
      },
    });
    stream.mockResolvedValue(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    await workspace.enter("c");
    workspace.watchRun("r");
    await vi.waitFor(() => expect(body.locked).toBe(true));
    await Promise.all([workspace.loadEvidence("r"), workspace.loadEvidence("r")]);
    expect(workspace.state.runs.r?.evidenceLoaded).toBe(true);
    snapshot = { ...snapshot, status: "completed", sequence: 1 };
    feed.enqueue(
      new TextEncoder().encode(
        'id: 1\nevent: run_completed\ndata: {"type":"run_completed","conversation_id":"c","analysis_run_id":"r","sequence":1}\n\n',
      ),
    );
    feed.close();
    await vi.waitFor(() => expect(workspace.state.runs.r?.connection).toBe("complete"));
    expect(workspace.state.runs.r?.evidenceLoaded).toBe(false);
    await workspace.loadEvidence("r");
    expect(request.mock.calls.filter(([path]) => path.endsWith("/evidence"))).toHaveLength(2);
    workspace.dispose();
  });
  it("回执丢失时同次重试复用幂等键，重复点击只产生一个在途请求", async () => {
    let attempts = 0;
    const { workspace, request } = fixture(async () => {
      if (++attempts === 1) throw new ApiError("响应丢失");
      return receipt;
    });
    await workspace.enter("c");
    workspace.setDraft("人次");
    await Promise.all([workspace.send(), workspace.send()]);
    expect(attempts).toBe(1);
    await workspace.send();
    const calls = request.mock.calls.filter(([path]) => path.endsWith("/messages"));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.body).toEqual(calls[1]?.[1]?.body);
    expect(workspace.state.detail?.messages).toHaveLength(1);
    expect(workspace.state.draft).toBe("");
    workspace.dispose();
  });
  it("切换会话保留草稿，退出清理草稿、结果和待确认提交", async () => {
    const { workspace, resources } = fixture();
    await workspace.enter("c");
    workspace.setDraft("按科室分组");
    await workspace.enter();
    workspace.setDraft("新的问题");
    await workspace.enter("c");
    expect(workspace.state.draft).toBe("按科室分组");
    resources.reset();
    expect(workspace.state.detail).toBeNull();
    expect(workspace.state.draft).toBe("");
    await workspace.enter("c");
    expect(workspace.state.draft).toBe("");
    workspace.dispose();
  });
  it("旧会话响应晚到时不能替换新会话，权限拒绝会清除原内容", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const { workspace, request } = fixture();
    request.mockImplementation(async (path) => {
      if (path.endsWith("/slow")) return pending;
      if (path.endsWith("/denied")) throw new ApiError("暂无权限", 403);
      return { items: [] };
    });
    const slow = workspace.enter("slow");
    await workspace.enter();
    resolve({ conversation: { ...conversation, id: "slow" }, messages: [] });
    await slow;
    expect(workspace.state.detail).toBeNull();
    await workspace.enter("denied");
    expect(workspace.state.detail).toBeNull();
    expect(workspace.state.error).toBeTruthy();
    workspace.dispose();
  });
});
