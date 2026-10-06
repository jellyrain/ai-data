import { filterConditionSchema, rowConditionSchema, rowPolicySchema } from "@ai-data/contracts";

import type { AuthContext } from "../auth/auth-types";
import type { AuthorizedDataset } from "../catalog/business-catalog-service";
import { QueryAuthorizationError } from "./query-authorization-error";
import type { QueryFilterGroup } from "./query-authorization-types";

/** 只读取 API 已建立的身份及已声明的可信范围字段。 */
function resolvePermissionValue(path: string, context: AuthContext): unknown {
  switch (path) {
    case "permission_context.user_id":
      return context.userId;
    case "permission_context.organization_id":
      return context.organizationId;
    case "permission_context.department_ids":
      return context.permissionContext?.department_ids;
    default:
      throw new QueryAuthorizationError("行策略引用的权限上下文字段不可用", "POLICY_REJECTED");
  }
}

/** 部门资料使用字符串 ID；整数字段只接受规范十进制且安全整数可无损表示的完整集合。 */
function integerDepartmentIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new QueryAuthorizationError("整数部门字段需要有效的部门范围", "POLICY_REJECTED");
  return value.map((id: unknown) => {
    if (typeof id !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(id))
      throw new QueryAuthorizationError("部门 ID 无法无损转换为整数", "POLICY_REJECTED");
    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed) || String(parsed) !== id)
      throw new QueryAuthorizationError("部门 ID 超出安全整数范围", "POLICY_REJECTED");
    return parsed;
  });
}

/** 将一条配置条件完整求值为所属对象上的类型化过滤条件。 */
function evaluateRowCondition(
  input: unknown,
  alias: string,
  authorized: AuthorizedDataset,
  context: AuthContext,
) {
  const parsed = rowConditionSchema.safeParse(input);
  if (!parsed.success) throw new QueryAuthorizationError("行策略条件格式无效", "POLICY_REJECTED");
  const condition = parsed.data;
  const column = authorized.dataset.columns.find((item) => item.name === condition.field);
  if (!column) throw new QueryAuthorizationError("行策略引用的字段不可用", "POLICY_REJECTED");
  const resolved =
    condition.value_from === undefined
      ? condition.value
      : resolvePermissionValue(condition.value_from, context);
  // 只适配可信部门上下文与整数目录字段；固定值、其他身份字段和字符串列保持原有校验。
  const value =
    condition.value_from === "permission_context.department_ids" && column.data_type === "integer"
      ? integerDepartmentIds(resolved)
      : resolved;
  const evaluated = filterConditionSchema.safeParse({
    field: `${alias}.${condition.field}`,
    op: condition.op,
    data_type: column.data_type,
    ...(value === undefined ? {} : { value }),
  });
  if (!evaluated.success)
    throw new QueryAuthorizationError("行策略值无法表达为有效对象过滤", "POLICY_REJECTED");
  return evaluated.data;
}

/** 允许范围取并集，再与本对象的强制身份范围及用户对象条件求交集。 */
function buildObjectFilters(
  alias: string,
  authorized: AuthorizedDataset,
  context: AuthContext,
  userFilters?: QueryFilterGroup,
): QueryFilterGroup | undefined {
  const grantedRoles = new Set(authorized.allowedRoleIds);
  const policies = authorized.rowPolicies.filter((policy) => grantedRoles.has(policy.role_id));
  const allowItems = policies.map((input) => {
    const parsed = rowPolicySchema.safeParse(input);
    if (!parsed.success || parsed.data.object_id !== authorized.dataset.object_id)
      throw new QueryAuthorizationError("对象行策略格式无效", "POLICY_REJECTED");
    return evaluateRowCondition(parsed.data.condition, alias, authorized, context);
  });
  // 任一获准角色没有行策略即允许该对象全范围；已配置条件仍须完成有效性校验。
  const isUnrestricted =
    context.roles.includes("system_admin") ||
    authorized.allowedRoleIds.some(
      (roleId) => !policies.some((policy) => policy.role_id === roleId),
    );
  const roleFilters: QueryFilterGroup | undefined = isUnrestricted
    ? undefined
    : { logic: "or", items: allowItems };
  const mandatoryItems = context.dataPolicies
    .filter((policy) => policy.mandatory && policy.resource === authorized.dataset.object_id)
    .map((policy) =>
      evaluateRowCondition(
        { field: policy.field, op: policy.operator, value: policy.value },
        alias,
        authorized,
        context,
      ),
    );
  const items: QueryFilterGroup["items"] = [
    ...(userFilters ? [userFilters] : []),
    ...(roleFilters ? [roleFilters] : []),
    ...mandatoryItems,
  ];
  if (items.length === 0) return undefined;
  if (items.length === 1 && "items" in items[0]) return items[0];
  return { logic: "and", items };
}

export { buildObjectFilters };
