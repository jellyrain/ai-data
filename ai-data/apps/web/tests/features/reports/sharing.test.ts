import { describe, it, expect, vi } from "vitest";
import type { ReportSharing } from "@ai-data/contracts";
import type { Transport } from "../../../src/shared/http/http-types";
import { ApiError } from "../../../src/shared/http/api-error";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ReportSharingController } from "../../../src/features/reports/stores/report-sharing";

const member = (id: string) => ({
  user_id: id,
  username: id,
  display_name: `成员 ${id}`,
  status: "active" as const,
});
const head = (ids: string[] = [], version = 1): ReportSharing => ({
  report_id: "report",
  basis: "definition",
  expected_version: version,
  owner_user_id: "owner",
  shared_with: ids,
  members: ids.map(member),
});
function setup() {
  const request = vi.fn<Transport>().mockResolvedValue(head());
  const resources = new SessionResources(),
    changed = vi.fn();
  const sharing = new ReportSharingController({
    request,
    resources,
    identity: () => ({ userId: "owner", organizationId: "org" }),
    changed,
  });
  return { sharing, request, resources, changed };
}
describe("作者分享面板", () => {
  it("未修改不提交，跨候选分页保留已选成员", async () => {
    const h = setup();
    await h.sharing.open("report");
    await h.sharing.save();
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValueOnce({ items: [member("a")], next_cursor: "a" });
    // 候选合同只包含展示字段。
    h.request.mockReset().mockResolvedValue({
      items: [{ user_id: "a", username: "a", display_name: "成员 a" }],
      next_cursor: "a",
    });
    await h.sharing.search("");
    h.sharing.toggle(h.sharing.state.candidates[0]!, true);
    h.request.mockResolvedValueOnce({
      items: [{ user_id: "b", username: "b", display_name: "成员 b" }],
    });
    await h.sharing.search("", true);
    expect(h.sharing.state.selected.map((m) => m.user_id)).toEqual(["a"]);
    expect(h.sharing.state.candidates).toHaveLength(2);
    h.sharing.dispose();
  });
  it("回执丢失后读取一致即成功，并接受实际版本基准", async () => {
    const h = setup();
    await h.sharing.open("report");
    h.sharing.toggle(member("a"), true);
    h.request
      .mockRejectedValueOnce(new ApiError("断开"))
      .mockResolvedValueOnce({ ...head(["a"], 4), basis: "snapshot" });
    await h.sharing.save();
    expect(h.sharing.state.baseline?.expected_version).toBe(4);
    expect(h.sharing.state.baseline?.basis).toBe("snapshot");
    expect(h.sharing.state.saved).toBe(true);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls.filter(([, o]) => o?.method === "PUT")).toHaveLength(1);
    h.sharing.dispose();
  });
  it("并发冲突保留草稿，经确认合并本地增删后使用最新版本", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce(head(["a"]));
    await h.sharing.open("report");
    h.sharing.toggle(member("a"), false);
    h.sharing.toggle(member("b"), true);
    h.request
      .mockRejectedValueOnce(new ApiError("版本冲突", 409))
      .mockResolvedValueOnce(head(["a", "c"], 2));
    await h.sharing.save();
    expect(h.sharing.state.selected.map((m) => m.user_id)).toEqual(["b"]);
    expect(h.sharing.state.conflict?.shared_with).toEqual(["a", "c"]);
    h.sharing.merge();
    expect(h.sharing.state.selected.map((m) => m.user_id).sort()).toEqual(["b", "c"]);
    h.request.mockResolvedValueOnce({}).mockResolvedValueOnce(head(["b", "c"], 3));
    await h.sharing.save();
    expect(h.request.mock.calls.at(-2)?.[1]?.body).toEqual({
      expected_version: 2,
      shared_with: ["c", "b"],
    });
    h.sharing.dispose();
  });
  it("已选停用成员必须移除，身份变化清空草稿并忽略晚到响应", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({
      ...head(["a"]),
      members: [{ ...member("a"), status: "disabled" }],
    });
    await h.sharing.open("report");
    h.sharing.toggle(member("b"), true);
    await h.sharing.save();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.sharing.state.error).toContain("移除");
    let release!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const opening = h.sharing.open("other");
    h.resources.reset();
    release({ ...head(), report_id: "other" });
    await opening;
    expect(h.sharing.state.baseline).toBeNull();
    expect(h.sharing.state.selected).toEqual([]);
    h.sharing.dispose();
  });
});
