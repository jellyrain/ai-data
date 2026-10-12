import { expect, it, vi } from "vitest";
import { AnalysisWorkspace } from "../../../src/features/analysis/stores/analysis-workspace";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";

it("图片解码完成前不会发送漏图消息，切换会话后丢弃迟到预览", async () => {
  const original = globalThis.createImageBitmap;
  let finish!: (bitmap: ImageBitmap) => void;
  globalThis.createImageBitmap = vi.fn(
    () =>
      new Promise<ImageBitmap>((done) => {
        finish = done;
      }),
  ) as unknown as typeof createImageBitmap;
  const conversation = {
    id: "c",
    userId: "u",
    organizationId: "o",
    title: "图片",
    status: "active",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
  };
  const request = vi.fn<Transport>(async (path) =>
    path === "/api/conversations/c" ? { conversation, messages: [] } : { items: [] },
  );
  const workspace = new AnalysisWorkspace({
    request,
    resources: new SessionResources(),
    stream: vi.fn(),
    identity: () => ({ userId: "u", organizationId: "o" }),
  });
  try {
    await workspace.enter("c");
    workspace.setDraft("看图");
    const adding = workspace.addImages([
      new File([new Uint8Array(10)], "test.png", { type: "image/png" }),
    ]);
    await workspace.send();
    expect(request.mock.calls.some(([path]) => path.endsWith("/messages"))).toBe(false);
    await workspace.enter();
    finish({ width: 64, height: 64, close: vi.fn() } as unknown as ImageBitmap);
    await adding;
    expect(workspace.state.images).toHaveLength(0);
  } finally {
    workspace.dispose();
    globalThis.createImageBitmap = original;
  }
});

it("图片发送回执丢失后沿用相同附件和消息幂等键，身份清理释放预览", async () => {
  const original = globalThis.createImageBitmap;
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  globalThis.createImageBitmap = vi.fn(async () => ({
    width: 64,
    height: 64,
    close: vi.fn(),
  })) as unknown as typeof createImageBitmap;
  const conversation = {
    id: "c",
    userId: "u",
    organizationId: "o",
    title: "图片",
    status: "active",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
  };
  let submitted = 0;
  const requests = vi.fn<Transport>(async (path, options): Promise<unknown> => {
    if (path === "/api/agents") return { items: [] };
    if (path === "/api/conversations") return { items: [conversation] };
    if (path === "/api/conversations/c") return { conversation, messages: [] };
    if (options?.method === "PUT")
      return {
        attachment_id: path.split("/").at(-1)?.split("?")[0],
        name: "test.png",
        mime_type: "image/png",
        size_bytes: 10,
        width: 64,
        height: 64,
      };
    if (path.endsWith("/messages")) {
      if (++submitted === 1) throw new ApiError("回执丢失");
      return {
        message: {
          id: "m",
          conversationId: "c",
          role: "user",
          content: "",
          attachments: workspace.state.images.map((image) => image.attachment),
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
    }
  });
  const resources = new SessionResources();
  const workspace = new AnalysisWorkspace({
    request: requests,
    resources,
    stream: vi.fn(),
    identity: () => ({ userId: "u", organizationId: "o" }),
  });
  try {
    await workspace.enter("c");
    await workspace.addImages([new File([new Uint8Array(10)], "test.png", { type: "image/png" })]);
    await workspace.send();
    expect(workspace.state.pendingMessage).toBe(true);
    await workspace.send();
    const messages = requests.mock.calls.filter(([path]) => path.endsWith("/messages"));
    expect(messages[0]?.[1]?.body).toEqual(messages[1]?.[1]?.body);
    expect(requests.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
    expect(workspace.state.detail?.messages[0]?.attachments).toHaveLength(1);
    expect(workspace.state.images).toHaveLength(0);
    await workspace.addImages([new File([new Uint8Array(10)], "test.png", { type: "image/png" })]);
    await workspace.enter();
    await workspace.enter("c");
    expect(workspace.state.images).toHaveLength(1);
    resources.reset();
    expect(workspace.state.images).toHaveLength(0);
  } finally {
    workspace.dispose();
    globalThis.createImageBitmap = original;
    vi.restoreAllMocks();
  }
});
