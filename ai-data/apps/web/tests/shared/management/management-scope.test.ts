import { describe, expect, it, vi } from "vitest";
import { ManagementScope } from "../../../src/shared/management/management-scope";
import { SessionResources } from "../../../src/shared/session/session-resources";
import { ApiError } from "../../../src/shared/http/api-error";

describe("管理页身份和失败边界", () => {
  it("换号时清理秘密，拒绝旧身份迟到回执", async () => {
    const resources = new SessionResources();
    let resolve!: (value: unknown) => void;
    const transport = vi.fn(
      () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    );
    const clear = vi.fn();
    const commit = vi.fn();
    const scope = new ManagementScope({ request: transport, resources, clear });
    const pending = scope.run(async (request) => {
      const result = await request("/api/models");
      commit(result);
    });
    resources.reset();
    resolve({ items: [] });
    await pending;
    expect(clear).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    scope.dispose();
  });
  it("权限撤回清理草稿，普通冲突保留草稿并显示请求编号", async () => {
    const resources = new SessionResources();
    const clear = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("版本冲突", 409, "CONFLICT", "req-9"))
      .mockRejectedValueOnce(new ApiError("权限撤回", 403));
    const scope = new ManagementScope({ request, resources, clear });
    await scope.run((send) => send("/api/models"));
    expect(clear).not.toHaveBeenCalled();
    expect(scope.state.error).toContain("req-9");
    await scope.run((send) => send("/api/models"));
    expect(clear).toHaveBeenCalledOnce();
    scope.dispose();
  });
});
