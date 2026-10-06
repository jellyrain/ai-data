import type { AuthContext } from "../features/auth/api/auth-types";
import type { NavigationItem } from "./navigation-types";

const navigation: NavigationItem[] = [
  {
    path: "/analysis",
    title: "分析工作台",
    group: "工作空间",
    description: "从一个业务问题开始，探索数据中的答案。",
  },
  {
    path: "/reports",
    title: "报表中心",
    group: "工作空间",
    description: "集中查看、管理和分享你的分析报表。",
  },
  {
    path: "/knowledge",
    title: "知识与偏好",
    group: "工作空间",
    description: "查阅企业知识，管理个人分析偏好。",
  },
  {
    path: "/settings/models",
    title: "模型管理",
    group: "分析能力",
    description: "管理组织可用的模型与连接配置。",
    permission: "models:manage",
  },
  {
    path: "/settings/agents",
    title: "Agent 管理",
    group: "分析能力",
    description: "管理分析助手及其工具与版本。",
    permission: "agents:manage",
  },
  {
    path: "/settings/users",
    title: "用户管理",
    group: "组织管理",
    description: "管理组织成员与账号状态。",
    permission: "user:manage",
  },
  {
    path: "/settings/permissions",
    title: "角色与权限",
    group: "组织管理",
    description: "管理角色、部门与数据访问范围。",
    permission: "catalog:manage",
  },
  {
    path: "/settings/data",
    title: "数据管理",
    group: "组织管理",
    description: "维护数据目录与业务关系。",
    anyPermissions: ["catalog:manage", "data-access:manage"],
  },
  {
    path: "/settings/knowledge",
    title: "知识审核",
    group: "组织管理",
    description: "审核并发布组织共享的业务知识。",
    permission: "knowledge:manage",
  },
  {
    path: "/settings/tasks",
    title: "后台任务",
    group: "组织管理",
    description: "查看组织任务的执行状态。",
    permission: "knowledge:manage",
  },
];

/** 菜单和直达路由共享授权判断，服务端继续执行最终授权。 */
function canAccess(item: NavigationItem, context: AuthContext | null): boolean {
  if (!context) return false;
  if (context.roles.includes("system_admin")) return true;
  if (item.adminOnly) return false;
  if (item.anyPermissions)
    return item.anyPermissions.some((permission) => context.permissions.includes(permission));
  return !item.permission || context.permissions.includes(item.permission);
}
export { navigation, canAccess };
