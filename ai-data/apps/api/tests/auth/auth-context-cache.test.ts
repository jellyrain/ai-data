import { describe, expect, it } from "vitest";

import { AuthContextCache } from "../../src/auth/auth-context-cache";
import type { AuthContext } from "../../src/auth/auth-types";

const context: AuthContext = {
  userId: "u",
  organizationId: "o",
  sessionId: "s",
  roles: [],
  permissions: [],
  dataPolicies: [],
};

describe("身份上下文缓存", () => {
  // BDD 场景：会话重复访问；TDD 断言：缓存返回同一权限上下文。
  it("缓存并读取上下文", () => {
    const cache = new AuthContextCache();
    cache.set("s", context);
    expect(cache.get("s")).toEqual(context);
  });

  // BDD 场景：会话注销；TDD 断言：缓存记录立即清除。
  it("支持主动失效", () => {
    const cache = new AuthContextCache();
    cache.set("s", context);
    cache.delete("s");
    expect(cache.get("s")).toBeNull();
  });
});
