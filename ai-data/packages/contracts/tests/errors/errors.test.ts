import { describe, expect, it } from "vitest";

import { contractErrorSchema } from "../../src/errors/errors";

// 错误码与载荷结构在这里检查，具体失败场景返回哪种错误由对应服务测试验证。
describe("合同错误合同", () => {
  it("接受未授权错误", () => {
    expect(
      contractErrorSchema.safeParse({
        code: "UNAUTHORIZED_OBJECT",
        message: "当前角色无权访问该数据对象",
        request_id: "request-001",
      }).success,
    ).toBe(true);
  });

  it("拒绝未知错误码", () => {
    expect(contractErrorSchema.safeParse({ code: "UNKNOWN", message: "失败" }).success).toBe(false);
  });

  it("接受认证、限流和取消错误", () => {
    for (const code of ["AUTHENTICATION_FAILED", "RATE_LIMITED", "CANCELLED"] as const) {
      expect(contractErrorSchema.safeParse({ code, message: "请求未完成" }).success).toBe(true);
    }
  });
});
