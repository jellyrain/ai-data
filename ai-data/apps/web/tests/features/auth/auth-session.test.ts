import { describe, expect, it, vi } from "vitest";
import { AuthSession } from "../../../src/features/auth/stores/auth-session";
import { ApiError } from "../../../src/shared/http/api-error";
import type { Transport } from "../../../src/shared/http/http-types";

const user = { id: "a", organizationId: "org", username: "analyst", displayName: "分析员" };
const context = {
  userId: "a",
  organizationId: "org",
  sessionId: "s",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
const result = (token = "old") => ({
  accessToken: token,
  refreshToken: "cookie-only",
  expiresIn: 900,
  user,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(override?: Transport) {
  const transport = vi.fn<Transport>(
    override ?? (async (path) => (path === "/auth/me" ? context : result())),
  );
  const reset = vi.fn();
  const publish = vi.fn();
  const auth = new AuthSession({
    transport,
    reset,
    publish,
    coordinate: async (operation) => operation(),
  });
  return { auth, transport, reset, publish };
}

describe("身份恢复与隔离", () => {
  it("退出遇到过期令牌时刷新一次后撤销服务端会话", async () => {
    let attempts = 0;
    const { auth, transport } = fixture(async (path) => {
      if (path === "/auth/logout" && attempts++ === 0) throw new ApiError("过期", 401);
      return path === "/auth/me" ? context : result();
    });
    await auth.login({ username: "analyst", password: "example" });
    await auth.logout();
    expect(attempts).toBe(2);
    expect(transport.mock.calls.filter(([path]) => path === "/auth/refresh")).toHaveLength(1);
    expect(auth.state.status).toBe("anonymous");
  });
  it("重复登录提交共用一次请求", async () => {
    const { auth, transport } = fixture();
    await Promise.all([
      auth.login({ username: "analyst", password: "example" }),
      auth.login({ username: "analyst", password: "example" }),
    ]);
    expect(transport.mock.calls.filter(([path]) => path === "/auth/login")).toHaveLength(1);
  });
  it("A 身份退出后 B 登录，A 的迟到错误不能影响 B", async () => {
    let currentUser = user;
    let currentContext = context;
    const { auth } = fixture(async (path) =>
      path === "/auth/me" ? currentContext : { ...result(), user: currentUser },
    );
    await auth.login({ username: "analyst", password: "example" });
    const delayed = deferred<void>();
    const old = auth.request(async () => {
      await delayed.promise;
      throw new ApiError("旧请求失效", 401);
    });
    const rejected = expect(old).rejects.toMatchObject({ code: "STALE_SESSION" });
    await auth.logout();
    currentUser = { ...user, id: "b" };
    currentContext = { ...context, userId: "b", sessionId: "b-session" };
    await auth.login({ username: "b", password: "example" });
    delayed.resolve();
    await rejected;
    expect(auth.state.context?.userId).toBe("b");
    expect(auth.state.status).toBe("authenticated");
  });
  it("登录后以 me 确认身份，前端状态不保存刷新令牌", async () => {
    const { auth, transport } = fixture();
    await auth.login({ username: "analyst", password: "example" });
    expect(auth.state).toMatchObject({ status: "authenticated", user, context });
    expect(transport).toHaveBeenCalledWith("/auth/me", { token: "old" });
    expect(JSON.stringify(auth.state)).not.toContain("cookie-only");
  });
  it("重复初始化共用一次 Cookie 刷新", async () => {
    const { auth, transport } = fixture();
    await Promise.all([auth.restore(), auth.restore(), auth.restore()]);
    expect(transport.mock.calls.filter(([p]) => p === "/auth/refresh")).toHaveLength(1);
  });
  it("刷新认证失败进入未登录，网络失败提供可恢复错误状态", async () => {
    const denied = fixture(async () => {
      throw new ApiError("失效", 401);
    });
    await denied.auth.restore();
    expect(denied.auth.state.status).toBe("anonymous");
    const offline = fixture(async () => {
      throw new ApiError("网络不可用");
    });
    await offline.auth.restore();
    expect(offline.auth.state.status).toBe("error");
  });
  it("登录响应与 me 的身份不匹配时拒绝装配", async () => {
    const { auth } = fixture(async (path) =>
      path === "/auth/me" ? { ...context, userId: "b" } : result(),
    );
    await expect(auth.login({ username: "analyst", password: "example" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(auth.state.user).toBeNull();
  });
  it("并发 401 只刷新一次，每个请求使用新令牌重放一次", async () => {
    const { auth, transport } = fixture(async (path) =>
      path === "/auth/me" ? context : result(path === "/auth/refresh" ? "new" : "old"),
    );
    await auth.login({ username: "analyst", password: "example" });
    const send = vi.fn(async (token: string) => {
      if (token === "old") throw new ApiError("过期", 401);
      return "done";
    });
    expect(await Promise.all([auth.request(send), auth.request(send), auth.request(send)])).toEqual(
      ["done", "done", "done"],
    );
    expect(transport.mock.calls.filter(([p]) => p === "/auth/refresh")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(6);
  });
  it("重放仍为 401 时停止，403 与网络错误不触发刷新", async () => {
    for (const status of [401, 403, 0]) {
      const { auth, transport } = fixture();
      await auth.login({ username: "analyst", password: "example" });
      const send = vi.fn(async () => {
        throw new ApiError("失败", status);
      });
      await expect(auth.request(send)).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
      expect(transport.mock.calls.filter(([p]) => p === "/auth/refresh")).toHaveLength(
        status === 401 ? 1 : 0,
      );
    }
  });
  it("退出清理资源并广播，旧请求晚到后不返回数据", async () => {
    const { auth, reset, publish } = fixture();
    await auth.login({ username: "analyst", password: "example" });
    const pending = deferred<string>();
    const request = auth.request(() => pending.promise);
    const rejected = expect(request).rejects.toThrow();
    await auth.logout();
    pending.resolve("a 的数据");
    await rejected;
    expect(auth.state.status).toBe("anonymous");
    expect(reset).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("logout");
  });
  it("退出失败允许重试，成功前不报告未登录", async () => {
    let failed = true;
    const { auth } = fixture(async (path) => {
      if (path === "/auth/logout" && failed) throw new ApiError("暂时不可用", 503);
      return path === "/auth/me" ? context : result();
    });
    await auth.login({ username: "analyst", password: "example" });
    await expect(auth.logout()).rejects.toThrow();
    expect(auth.state.status).toBe("logout-error");
    failed = false;
    await auth.logout();
    expect(auth.state.status).toBe("anonymous");
  });
  it("其他标签页退出后，正在进行的恢复不能重新登录", async () => {
    const pending = deferred<unknown>();
    const { auth } = fixture(async (path) =>
      path === "/auth/refresh" ? pending.promise : context,
    );
    const restoring = auth.restore().catch(() => {});
    await auth.receive("logout");
    pending.resolve(result());
    await restoring;
    expect(auth.state.status).toBe("anonymous");
    expect(auth.state.user).toBeNull();
  });
});
