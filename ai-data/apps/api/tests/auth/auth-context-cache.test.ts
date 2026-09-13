import { describe, expect, it } from "vitest";

import { AuthContextCache } from "../../src/auth/auth-context-cache";
import type { AuthContext } from "../../src/auth/auth-types";

/** 缓存测试用的最小身份快照。 */
const context: AuthContext = {
  userId: "u",
  organizationId: "o",
  sessionId: "s",
  roles: [],
  permissions: [],
  dataPolicies: [],
};

describe("身份上下文缓存", () => {
  it("缓存并读取上下文", () => {
    const cache = new AuthContextCache();
    cache.set("s", context);
    expect(cache.get("s")).toEqual(context);
  });

  it("支持主动失效", () => {
    const cache = new AuthContextCache();
    cache.set("s", context);
    cache.delete("s");
    expect(cache.get("s")).toBeNull();
  });
});
