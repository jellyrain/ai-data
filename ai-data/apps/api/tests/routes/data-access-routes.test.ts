import { describe, expect, it } from "vitest";

import { deriveDataAccessServiceUrl } from "../../src/routes/data-access-routes";

describe("DAS 心跳服务地址推导", () => {
  // BDD 场景：DAS 通过 IPv4 地址主动向 API 发送心跳；TDD 断言：API 组合远端地址与监听端口。
  it("使用 IPv4 远端地址和上报端口生成内部调用地址", () => {
    expect(deriveDataAccessServiceUrl("10.10.8.15", 3102, "http")).toBe("http://10.10.8.15:3102");
  });

  // BDD 场景：本机 Node 连接以 IPv4 映射 IPv6 地址出现；TDD 断言：API 保存可直接调用的 IPv4 地址。
  it("规范化 IPv4 映射地址和本机 IPv6 回环地址", () => {
    expect(deriveDataAccessServiceUrl("::ffff:127.0.0.1", 3102, "http")).toBe(
      "http://127.0.0.1:3102",
    );
    expect(deriveDataAccessServiceUrl("::1", 3102, "http")).toBe("http://127.0.0.1:3102");
  });

  // BDD 场景：DAS 通过 IPv6 网络发送心跳；TDD 断言：API 为 URL 正确包裹 IPv6 主机。
  it("使用方括号包裹 IPv6 地址", () => {
    expect(deriveDataAccessServiceUrl("2001:db8::15", 3102, "https")).toBe(
      "https://[2001:db8::15]:3102",
    );
  });
});
