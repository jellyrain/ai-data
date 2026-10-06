import { describe, it, expect } from "vitest";
import { canAccess, navigation } from "../../src/app/navigation";
const base = {
  userId: "u",
  organizationId: "o",
  sessionId: "s",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
describe("管理入口最小权限", () => {
  it.each([
    ["models:manage", ["/settings/models"]],
    ["agents:manage", ["/settings/agents"]],
    ["user:manage", ["/settings/users"]],
    ["catalog:manage", ["/settings/permissions", "/settings/data"]],
    ["data-access:manage", ["/settings/data"]],
    ["analysis:execute", []],
  ] as const)("%s 只开放对应管理入口", (permission, paths) => {
    const available = navigation
      .filter(
        (item) =>
          item.path.startsWith("/settings/") &&
          canAccess(item, { ...base, permissions: [permission] }),
      )
      .map((item) => item.path);
    expect(available.sort()).toEqual([...paths].sort());
  });
  it.each(["catalog:manage", "data-access:manage"])("仅有 %s 可进入数据管理", (permission) =>
    expect(
      canAccess(
        navigation.find((item) => item.path === "/settings/data")!,
        { ...base, permissions: [permission] },
      ),
    ).toBe(true),
  );
  it("目录管理员可进入策略页，DAS 管理员不能进入策略页", () => {
    const item = navigation.find((item) => item.path === "/settings/permissions")!;
    expect(canAccess(item, { ...base, permissions: ["catalog:manage"] })).toBe(true);
    expect(canAccess(item, { ...base, permissions: ["data-access:manage"] })).toBe(false);
  });
});
