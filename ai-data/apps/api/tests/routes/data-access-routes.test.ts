import { describe, expect, it } from "vitest";

import { deriveDataAccessServiceUrl } from "../../src/routes/data-access-routes";

describe("DAS 心跳服务地址推导", () => {
  it("使用 IPv4 远端地址和上报端口生成内部调用地址", () => {
    expect(deriveDataAccessServiceUrl("10.10.8.15", 3102, "http")).toBe("http://10.10.8.15:3102");
  });

  it("规范化 IPv4 映射地址和本机 IPv6 回环地址", () => {
    expect(deriveDataAccessServiceUrl("::ffff:127.0.0.1", 3102, "http")).toBe(
      "http://127.0.0.1:3102",
    );
    expect(deriveDataAccessServiceUrl("::1", 3102, "http")).toBe("http://127.0.0.1:3102");
  });

  it("使用方括号包裹 IPv6 地址", () => {
    expect(deriveDataAccessServiceUrl("2001:db8::15", 3102, "https")).toBe(
      "https://[2001:db8::15]:3102",
    );
  });
});
