import { describe, expect, it, vi } from "vitest";
import { ReportEditor } from "../../../src/features/reports/stores/report-editor";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";
import { definition } from "./fixtures";

function setup() {
  const request = vi.fn<Transport>(async () => structuredClone(definition));
  const resources = new SessionResources();
  const editor = new ReportEditor({
    request,
    resources,
    identity: () => ({ userId: "user", organizationId: "org" }),
  });
  return { request, resources, editor };
}
describe("统一编辑的保存与恢复", () => {
  it("新建仅在显式保存时创建定义，返回ID后继续在同一版本链编辑", async () => {
    const h = setup();
    await h.editor.open();
    expect(h.request).not.toHaveBeenCalled();
    h.editor.update(structuredClone(definition.definition));
    expect(h.editor.dirty).toBe(true);
    expect(await h.editor.save()).toBe(true);
    expect(h.request.mock.calls[0]).toMatchObject([
      "/api/report-definitions",
      { method: "POST", body: { definition: definition.definition, shared_with: [] } },
    ]);
    expect(h.editor.state.reportId).toBe("report");
    expect(h.editor.dirty).toBe(false);
    h.editor.dispose();
  });
  it("完整保存保留分享名单和来源，冲突保留草稿并读取最新版本供选择", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({
      ...definition,
      shared_with: ["reader"],
      source_analysis_run_id: "source",
    });
    await h.editor.open("report");
    h.editor.update({ ...h.editor.state.draft, title: "本地标题" });
    h.request
      .mockRejectedValueOnce(new ApiError("版本冲突", 409))
      .mockResolvedValueOnce({ ...definition, version: 2, shared_with: ["new-reader"] });
    expect(await h.editor.save()).toBe(false);
    expect(h.request.mock.calls[1]?.[1]?.body).toMatchObject({
      expected_version: 1,
      shared_with: ["reader"],
      source_analysis_run_id: "source",
    });
    expect(h.editor.state.draft.title).toBe("本地标题");
    expect(h.editor.state.latest?.version).toBe(2);
    h.editor.resolveConflict("local");
    expect(h.editor.state.baseline?.version).toBe(2);
    expect(h.editor.state.baseline?.shared_with).toEqual(["new-reader"]);
    expect(h.editor.state.draft.title).toBe("本地标题");
    h.editor.dispose();
  });
  it("创建回执丢失后不自动重复创建，修改已知报表可只读核对保存内容", async () => {
    const h = setup();
    await h.editor.open();
    h.editor.update(structuredClone(definition.definition));
    h.request.mockRejectedValueOnce(new ApiError("连接中断"));
    await h.editor.save();
    await h.editor.save();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.editor.state.uncertain).toBe(true);
    h.editor.dispose();
  });
  it("拒绝非作者，身份切换后晚到读取不能恢复草稿", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({ ...definition, user_id: "other" });
    await h.editor.open("report");
    expect(h.editor.state.ready).toBe(false);
    expect(h.editor.state.error).toContain("作者");
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const loading = h.editor.open("report");
    h.resources.reset();
    release(definition);
    await loading;
    expect(h.editor.state.baseline).toBeNull();
    expect(h.editor.state.reportId).toBe("");
    h.editor.dispose();
  });
});

describe("组织模板新建个人报表", () => {
  it("复制已发布固定定义，保存前不写入且不继承作者分享和执行来源", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({
      items: [
        {
          ...definition,
          user_id: "author",
          shared_with: ["reader"],
          source_analysis_run_id: "private-run",
        },
      ],
    });
    await h.editor.openTemplate(definition.report_id, definition.version);
    expect(h.editor.state.reportId).toBe("");
    expect(h.editor.state.baseline).toBeNull();
    expect(h.editor.state.draft).toEqual(definition.definition);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValueOnce(definition);
    await h.editor.save();
    expect(h.request.mock.calls[1]).toMatchObject([
      "/api/report-definitions",
      { method: "POST", body: { definition: definition.definition, shared_with: [] } },
    ]);
    expect(h.request.mock.calls[1]?.[1]?.body).not.toHaveProperty("source_analysis_run_id");
    h.editor.dispose();
  });
  it("停用模板不能通过旧链接载入，换号后的迟到结果不能恢复定义", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({ items: [] });
    await h.editor.openTemplate("old", 1);
    expect(h.editor.state.ready).toBe(false);
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const loading = h.editor.openTemplate(definition.report_id, definition.version);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.resources.reset();
    release({ items: [definition] });
    await loading;
    expect(h.editor.state.ready).toBe(false);
    expect(h.editor.state.draft.queries).toEqual([]);
    h.editor.dispose();
  });
});
