import { describe, it, expect, vi } from "vitest";
import { createTransport } from "../../src/shared/http/transport";
import { SessionResources } from "../../src/shared/session/session-resources";
describe("HTTP 边界与身份资源", () => {
  it("同源 Cookie、Bearer、JSON 及 204 正常传递", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const send = createTransport(fetcher);
    await expect(
      send("/auth/logout", { method: "POST", token: "access" }),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ Authorization: "Bearer access" }),
      }),
    );
    await expect(send("https://elsewhere.test/api", { token: "secret" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("保留合同错误码与请求编号，拒绝 HTML 响应", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { code: "UNAUTHORIZED", message: "无权限", request_id: "request-1" },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(new Response("<html>oops</html>"));
    const send = createTransport(fetcher);
    await expect(send("/api/data")).rejects.toMatchObject({
      status: 403,
      code: "UNAUTHORIZED",
      requestId: "request-1",
    });
    await expect(send("/api/data")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("退出时终止请求并执行已注册的长连接清理", async () => {
    const resources = new SessionResources();
    const close = vi.fn();
    resources.register(close);
    let requestSignal: AbortSignal | undefined;
    const pending = resources.run(async (signal) => {
      requestSignal = signal;
      await Promise.resolve();
      return "done";
    });
    resources.reset();
    expect(requestSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    await pending;
  });
});
// 加入 apps/web/tests/shared/http.test.ts 的 HTTP 场景组。
it("报表可等待 150 秒，普通请求仍为 20 秒，超限等待被拒绝", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const send = createTransport(
    vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true })),
  );
  await send("/api/reports");
  expect(timeout).toHaveBeenLastCalledWith(20_000);
  await send("/api/reports/r/execute", { timeoutMs: 150_000 });
  expect(timeout).toHaveBeenLastCalledWith(150_000);
  await expect(send("/api/reports", { timeoutMs: 150_001 })).rejects.toMatchObject({
    code: "INVALID_TIMEOUT",
  });
  timeout.mockRestore();
});
