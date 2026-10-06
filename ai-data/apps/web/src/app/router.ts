import { createRouter, createWebHistory, type Router, type RouterHistory } from "vue-router";
import type { AuthSession } from "../features/auth/stores/auth-session";
import { navigation, canAccess } from "./navigation";

/** 返回地址必须是已注册的站内页面，避免登录后跳转到外部地址。 */
function safeReturnPath(value: unknown, router: Router): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  )
    return "/analysis";
  const target = router.resolve(value);
  if (!target.matched.length || ["login", "not-found", "forbidden"].includes(String(target.name)))
    return "/analysis";
  return target.fullPath;
}
/** 路由初始化等待身份恢复，权限规则与导航入口保持一致。 */
function createAppRouter(auth: AuthSession, history: RouterHistory = createWebHistory()): Router {
  const modulePage = () => import("./module-page.vue");
  const analysisPage = () => import("../features/analysis/pages/analysis-page.vue");
  const managementPages: Record<string, () => Promise<unknown>> = {
    "/knowledge": () => import("../features/knowledge/pages/knowledge-page.vue"),
    "/settings/knowledge": () => import("../features/knowledge/pages/knowledge-page.vue"),
    "/settings/tasks": () => import("../features/tasks/pages/tasks-page.vue"),
    "/settings/models": () => import("../features/models/pages/models-page.vue"),
    "/settings/agents": () => import("../features/agents/pages/agents-page.vue"),
    "/settings/users": () => import("../features/users/pages/users-page.vue"),
    "/settings/permissions": () => import("../features/permissions/pages/permissions-page.vue"),
    "/settings/data": () => import("../features/data-management/pages/data-management-page.vue"),
  };
  const router = createRouter({
    history,
    routes: [
      { path: "/", redirect: "/analysis" },
      {
        path: "/login",
        name: "login",
        component: () => import("../features/auth/pages/login-page.vue"),
      },
      ...navigation.map((item) => ({
        path: item.path,
        name: item.path,
        component:
          item.path === "/analysis"
            ? analysisPage
            : item.path === "/reports"
              ? () => import("../features/reports/pages/report-center.vue")
              : (managementPages[item.path] ?? modulePage),
        meta: { item },
      })),
      { path: "/analysis/:id", component: analysisPage, meta: { item: navigation[0] } },
      {
        path: "/reports/:id",
        component: () => import("../features/reports/pages/report-detail.vue"),
        meta: { item: navigation[1] },
      },
      {
        path: "/reports/new",
        component: () => import("../features/reports/pages/report-editor.vue"),
        meta: { item: navigation[1] },
      },
      {
        path: "/reports/:id/edit",
        component: () => import("../features/reports/pages/report-editor.vue"),
        meta: { item: navigation[1] },
      },
      { path: "/forbidden", name: "forbidden", component: () => import("./status-page.vue") },
      { path: "/:pathMatch(.*)*", name: "not-found", component: () => import("./status-page.vue") },
    ],
  });
  router.beforeEach(async (to) => {
    await auth.restore();
    if (
      auth.state.status === "error" ||
      auth.state.status === "logout-error" ||
      auth.state.status === "logging-out"
    )
      return true;
    if (auth.state.status !== "authenticated")
      return to.name === "login"
        ? true
        : { name: "login", query: { returnTo: to.fullPath }, replace: true };
    if (to.name === "login") return safeReturnPath(to.query.returnTo, router);
    const item = navigation.find((entry) => entry === to.meta.item);
    if (item && !canAccess(item, auth.state.context)) return { name: "forbidden", replace: true };
    return true;
  });
  return router;
}
export { createAppRouter, safeReturnPath };
