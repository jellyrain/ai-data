import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { Transport } from "../../../src/shared/http/http-types";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import { ExportController } from "../../../src/features/exports/export-controller";
import { execution } from "./fixtures";
function setup() {
  const pack = { kind: "report_execution", execution, narratives: [] };
  const request = vi.fn<Transport>().mockResolvedValue(pack),
    resources = new SessionResources(),
    generate = vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    download = vi.fn();
  const exporter = new ExportController({
    request,
    resources,
    identity: () => ({ userId: "user", organizationId: "org" }),
    generate,
    download,
  });
  return { exporter, request, resources, generate, download, pack };
}
afterEach(() => vi.unstubAllGlobals());

describe.each([true, false])("文件导出生命周期，原生摘要可用=%s", (native) => {
  beforeEach(() => vi.stubGlobal("crypto", native ? webcrypto : {}));
  it("未选中的表格数据不复制给生成 Worker", async () => {
    const h = setup(),
      record = structuredClone(execution);
    record.definition.queries.push({ ...record.definition.queries[0]!, query_id: "other" });
    record.results.push({
      ...record.results[0]!,
      query_id: "other",
      evidence: { ...record.results[0]!.evidence, evidence_id: "other-evidence" },
    });
    h.request.mockResolvedValue({ ...h.pack, execution: record });
    await h.exporter.open({ kind: "execution", id: "execution", reportId: "report" });
    await h.exporter.generate("xlsx", ["evidence"], 100);
    expect(
      h.generate.mock.calls[0]![0].document.tables.map((table: { id: string }) => table.id),
    ).toEqual(["evidence"]);
    h.exporter.dispose();
  });
  it("生成和下载都复核固定来源，只读且不重跑查询", async () => {
    const h = setup();
    await h.exporter.open({ kind: "execution", id: "execution", reportId: "report" });
    await h.exporter.generate("xlsx", ["evidence"], 100);
    expect(h.exporter.state.ready).toBe(true);
    expect(h.download).not.toHaveBeenCalled();
    await h.exporter.download();
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(
      h.request.mock.calls.every(([path, o]) => path.endsWith("/export-content") && !o?.method),
    ).toBe(true);
    h.exporter.dispose();
  });
  it("下载前权限收窄清空内容和文件", async () => {
    const h = setup();
    await h.exporter.open({ kind: "execution", id: "execution", reportId: "report" });
    await h.exporter.generate("pdf", ["evidence"], 100);
    h.request.mockRejectedValueOnce(new ApiError("权限已撤回", 403));
    await h.exporter.download();
    expect(h.download).not.toHaveBeenCalled();
    expect(h.exporter.state.document).toBeNull();
    expect(h.exporter.state.ready).toBe(false);
    h.exporter.dispose();
  });
  it("包内新增说明后必须重新生成，不能下载旧文件", async () => {
    const h = setup();
    await h.exporter.open({ kind: "execution", id: "execution", reportId: "report" });
    await h.exporter.generate("docx", ["evidence"], 100);
    h.request.mockResolvedValueOnce({
      ...h.pack,
      narratives: [
        {
          execution_id: "execution",
          analysis_run_id: "n",
          content: "新说明",
          query_ids: ["visits"],
          created_at: execution.created_at,
        },
      ],
    });
    await h.exporter.download();
    expect(h.download).not.toHaveBeenCalled();
    expect(h.exporter.state.error).toContain("重新生成");
    expect(h.exporter.state.ready).toBe(false);
    h.exporter.dispose();
  });
  it("取消和身份清理中止生成，晚到缓冲不能恢复可下载文件", async () => {
    const h = setup();
    await h.exporter.open({ kind: "execution", id: "execution", reportId: "report" });
    let release!: (value: ArrayBuffer) => void;
    h.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.exporter.generate("xlsx", ["evidence"], 100);
    await vi.waitFor(() => expect(h.generate).toHaveBeenCalled());
    const signal = h.generate.mock.calls[0]![1] as AbortSignal;
    h.resources.reset();
    release(new ArrayBuffer(8));
    await pending;
    expect(signal.aborted).toBe(true);
    expect(h.exporter.state.ready).toBe(false);
    expect(h.exporter.state.document).toBeNull();
    h.exporter.dispose();
  });
});
