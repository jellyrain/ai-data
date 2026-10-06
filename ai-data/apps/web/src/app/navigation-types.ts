/** 模块入口和访问能力；同一声明用于菜单与路由。 */
type NavigationItem = {
  path: string;
  title: string;
  group: string;
  description: string;
  permission?: string;
  adminOnly?: boolean;
  anyPermissions?: string[];
};
export type { NavigationItem };
