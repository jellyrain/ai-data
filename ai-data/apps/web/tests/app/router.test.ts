import { describe, it, expect, vi } from "vitest";
import { createMemoryHistory } from "vue-router";
import { createAppRouter, safeReturnPath } from "../../src/app/router";
import { AuthSession } from "../../src/features/auth/stores/auth-session";
import { canAccess, navigation } from "../../src/app/navigation";
const context = {
  userId: "u",
  organizationId: "o",
  sessionId: "s",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
// 这里只验证路由授权，页面组件的编译与渲染由组件和浏览器用例覆盖。
vi.mock("../../src/app/module-page.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../../src/app/status-page.vue", () => ({ default: { template: "<div />" } }));
vi.mock("../../src/features/reports/pages/report-editor.vue", () => ({
  default: { template: "<div />" },
}));
function fixture() {
  const auth = new AuthSession({
    transport: async (path) =>
      path === "/auth/me"
        ? context
        : {
            accessToken: "t",
            refreshToken: "r",
            expiresIn: 900,
            user: { id: "u", organizationId: "o", username: "u", displayName: "u" },
          },
    reset: () => {},
    coordinate: (operation) => operation(),
  });
  return { auth, router: createAppRouter(auth, createMemoryHistory()) };
}
describe("路由与导航权限", () => {
  it("只接受已注册站内返回地址", () => {
    const { router } = fixture();
    for (const path of [
      "//evil.example",
      "https://evil.example",
      "/\\evil.example",
      "/missing",
      "/login",
      "/login?returnTo=/login",
      null,
    ])
      expect(safeReturnPath(path, router)).toBe("/analysis");
    expect(safeReturnPath("/reports/123/edit?tab=query", router)).toBe(
      "/reports/123/edit?tab=query",
    );
  });
  it("恢复身份后保留深层页面，普通身份直达管理页被拒绝", async () => {
    const { router } = fixture();
    await router.push("/reports/123/edit");
    expect(router.currentRoute.value.path).toBe("/reports/123/edit");
    await router.push("/settings/models");
    expect(router.currentRoute.value.name).toBe("forbidden");
    expect(canAccess(navigation[3], context)).toBe(false);
    expect(canAccess(navigation[3], { ...context, permissions: ["models:manage"] })).toBe(true);
    expect(canAccess(navigation[3], { ...context, roles: ["system_admin"] })).toBe(true);
  });
});
