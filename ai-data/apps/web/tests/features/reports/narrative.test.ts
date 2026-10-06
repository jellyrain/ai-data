import { describe, it, expect, vi } from "vitest";
import { ReportNarratives } from "../../../src/features/reports/stores/report-narratives";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";
const item = {
  execution_id: "first",
  analysis_run_id: "run",
  content: "已保存的结论",
  query_ids: ["q"],
  created_at: "2026-09-28 08:00:00",
};
function setup() {
  const request = vi.fn<Transport>(async () => ({ items: [] }));
  const resources = new SessionResources();
  const store = new ReportNarratives({
    request,
    resources,
    identity: () => ({ userId: "user", organizationId: "org" }),
    stream: vi.fn(),
  });
  return { store, request, resources };
}
describe("AI 说明固定于当前执行", () => {
  it("执行切换后忽略迟到说明，身份清理后正文清空", async () => {
    const h = setup();
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const first = h.store.select("first");
    await h.store.select("second");
    release({ items: [item] });
    await first;
    expect(h.store.state.items).toEqual([]);
    h.request.mockResolvedValueOnce({ items: [{ ...item, execution_id: "second" }] });
    await h.store.load();
    expect(h.store.state.items).toHaveLength(1);
    h.resources.reset();
    expect(h.store.state.items).toEqual([]);
    h.store.dispose();
  });
  it("未确认回执重试复用键，正文仅从当前执行已保存列表读取", async () => {
    const h = setup();
    await h.store.select("first");
    h.request.mockRejectedValue(new ApiError("连接中断"));
    await h.store.start("比较变化");
    await h.store.start("比较变化");
    expect(h.request.mock.calls.at(-1)?.[1]?.body).toEqual(h.request.mock.calls.at(-2)?.[1]?.body);
    h.request.mockResolvedValueOnce({ items: [{ ...item, execution_id: "other" }] });
    await h.store.load();
    expect(h.store.state.items).toEqual([]);
    expect(h.store.state.error).not.toBe("");
    h.store.dispose();
  });
});
