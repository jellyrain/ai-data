import { describe, expect, it } from "vitest";

import { contractErrorSchema } from "../../src/errors/errors";

describe("合同错误合同", () => {
  // BDD 场景：查询因未授权对象被拒绝；TDD 断言：客户端可以依据稳定错误码处理。
  it("接受未授权错误", () => {
    expect(
      contractErrorSchema.safeParse({
        code: "UNAUTHORIZED_OBJECT",
        message: "当前角色无权访问该数据对象",
        request_id: "request-001",
      }).success,
    ).toBe(true);
  });

  // BDD 场景：服务端返回未定义错误码；TDD 断言：错误码必须受合同约束。
  it("拒绝未知错误码", () => {
    expect(contractErrorSchema.safeParse({ code: "UNKNOWN", message: "失败" }).success).toBe(false);
  });

  // BDD 场景：服务端返回常见运行错误；TDD 断言：公共错误码可以被各服务统一解析。
  it("接受认证、限流和取消错误", () => {
    for (const code of ["AUTHENTICATION_FAILED", "RATE_LIMITED", "CANCELLED"] as const) {
      expect(contractErrorSchema.safeParse({ code, message: "请求未完成" }).success).toBe(true);
    }
  });
});
