import { describe, expect, it } from "vitest";
import { connectionContext } from "../../../src/shared/security/connection-context";

describe("用户区连接环境说明", () => {
  it("HTTPS 安全上下文显示已加密", () => {
    expect(connectionContext("https:", true)).toMatchObject({
      label: "HTTPS 已加密",
      kind: "secure",
    });
  });
  it("本机 HTTP 被浏览器信任时仍明确连接未加密", () => {
    const state = connectionContext("http:", true, "127.0.0.1");
    expect(state).toMatchObject({ label: "本机 HTTP", kind: "local" });
    expect(state.description).toContain("未使用 HTTPS 加密");
  });
  it("普通 HTTP 提示未加密与非安全上下文", () => {
    const state = connectionContext("http:", false);
    expect(state).toMatchObject({ label: "HTTP 未加密", kind: "warning" });
    expect(state.description).toContain("非安全上下文");
  });
  it("浏览器额外信任的 HTTP 来源保持协议事实", () => {
    expect(connectionContext("http:", true, "intranet.example")).toMatchObject({
      label: "HTTP 可信来源",
      kind: "local",
    });
  });
  it("HTTPS 页面处于受限上下文时保留浏览器限制说明", () => {
    const state = connectionContext("https:", false);
    expect(state.kind).toBe("warning");
    expect(state.description).toContain("非安全上下文");
  });
});
