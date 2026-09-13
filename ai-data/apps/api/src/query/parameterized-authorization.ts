import {
  isDataValue,
  outputMaskSchema,
  type ApiDatasetConfig,
  type QueryAccessContext,
} from "@ai-data/contracts";

import type { AuthContext } from "../auth/auth-types";
import type { AuthorizedDataset } from "../catalog/business-catalog-service";
import { resolveParameterDefinitions } from "../catalog/parameter-config";
import { QueryAuthorizationError } from "./query-authorization-error";
import type { ParameterizedQuery, QueryFilterGroup } from "./query-authorization-types";
import { buildObjectFilters } from "./row-policy-filters";

/** 推导缺省权限参数时最多检查 4096 个候选状态，超过后要求调用方明确参数。 */
const maxPermissionCombinations = 4096;
/** eq/in 的所有未列出取值具有相同真假结果，用一个内部哨兵验证范围是否仍包含其他值。 */
const otherPermissionValue = Symbol("other-permission-value");

/**
 * 验收整个固定输出，再把当前角色并集与强制身份交集转换为已验收的等值参数。
 * 数据源保证每个绑定字段等于对应参数，因此完整参数组合落在行策略内即可保证返回范围。
 */
function authorizeParameterizedQuery(
  query: ParameterizedQuery,
  authorized: AuthorizedDataset,
  config: ApiDatasetConfig | null,
  context: AuthContext,
): { query: ParameterizedQuery; outputMasks: QueryAccessContext["output_masks"] } {
  const { dataset, rawColumns } = authorized;
  if (dataset.kind !== "stored_procedure" && dataset.kind !== "api_dataset")
    throw new QueryAuthorizationError("对象不支持参数化查询", "UNSUPPORTED_QUERY");
  if (
    dataset.has_complete_output !== true ||
    rawColumns.length === 0 ||
    new Set(rawColumns.map((column) => column.name)).size !== rawColumns.length
  )
    throw new QueryAuthorizationError("参数化数据集缺少可信完整输出定义", "POLICY_REJECTED");
  const visibleFields = new Set(dataset.columns.map((column) => column.name));
  if (rawColumns.some((column) => !visibleFields.has(column.name)))
    throw new QueryAuthorizationError("固定输出包含无权访问的字段", "UNAUTHORIZED_COLUMN");

  const definitions = resolveParameterDefinitions(
    { ...dataset, columns: rawColumns },
    config ?? undefined,
  );
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const parameters = new Map<string, ParameterizedQuery["parameters"][number]>();
  for (const parameter of query.parameters) {
    const definition = definitionsByName.get(parameter.name);
    if (
      parameters.has(parameter.name) ||
      !definition ||
      parameter.data_type !== definition.data_type ||
      !isDataValue(parameter.value, definition.data_type)
    )
      throw new QueryAuthorizationError(`查询参数无效: ${parameter.name}`, "INVALID_INPUT");
    parameters.set(parameter.name, parameter);
  }

  // 行范围求值使用可信原始类型，目录可见性不能改变权限条件的含义。
  const filters = buildObjectFilters(
    query.from.alias,
    { ...authorized, dataset: { ...dataset, columns: rawColumns } },
    context,
  );
  const bindings = config?.query_permission_bindings ?? [];
  if (filters) {
    const conditions = flattenConditions(filters);
    const boundFields = new Map(
      bindings.map((binding) => [`${query.from.alias}.${binding.field}`, binding]),
    );
    const fields = [...new Set(conditions.map((condition) => condition.field))];
    for (const condition of conditions) {
      if (!boundFields.has(condition.field) || (condition.op !== "eq" && condition.op !== "in"))
        throw new QueryAuthorizationError("行范围无法映射到完整的等值权限参数", "POLICY_REJECTED");
    }
    const candidates = fields.map((field) => {
      const binding = boundFields.get(field)!;
      const supplied = parameters.get(binding.parameter);
      if (supplied) {
        if (supplied.value === null)
          throw new QueryAuthorizationError("等值权限参数必须是非空标量", "POLICY_REJECTED");
        return [supplied.value];
      }
      const definition = definitionsByName.get(binding.parameter)!;
      const column = rawColumns.find((item) => item.name === binding.field)!;
      const values = conditions
        .filter((condition) => condition.field === field)
        .flatMap((condition) =>
          Array.isArray(condition.value) ? condition.value : [condition.value],
        );
      // 布尔值枚举完整物理域；其他类型把未出现在条件中的值合并为一个等价类。
      return [
        ...new Set([
          ...(definition.data_type === "boolean"
            ? [true, false]
            : [...values, otherPermissionValue]),
          ...(column.nullable ? [null] : []),
        ]),
      ];
    });
    const values = resolveUniquePermissionValues(filters, fields, candidates);
    if (!values) throw new QueryAuthorizationError("查询参数与当前授权范围冲突", "POLICY_REJECTED");
    for (const field of fields) {
      const name = boundFields.get(field)!.parameter;
      parameters.set(name, {
        name,
        value: values.get(field),
        data_type: definitionsByName.get(name)!.data_type,
      });
    }
  }

  const permissionParameters = new Set(bindings.map((binding) => binding.parameter));
  for (const definition of definitions) {
    if (parameters.has(definition.name)) continue;
    // 权限参数由当前授权范围或显式输入提供；普通默认值写入最终签名请求。
    if (!permissionParameters.has(definition.name) && definition.default_value !== undefined)
      parameters.set(definition.name, {
        name: definition.name,
        data_type: definition.data_type,
        value: definition.default_value,
      });
    else if (definition.required)
      throw new QueryAuthorizationError(`缺少必填参数: ${definition.name}`, "INVALID_INPUT");
  }

  const outputMasks = rawColumns.flatMap((column) => {
    const policy = config?.column_policies.find((item) => item.field === column.name);
    if (
      !policy ||
      policy.default_masking.type === "none" ||
      policy.unmasked_role_ids.some((roleId) => context.roleIds?.includes(roleId))
    )
      return [];
    const parsed = outputMaskSchema.safeParse({
      result_column: column.name,
      rule: policy.default_masking,
    });
    if (!parsed.success)
      throw new QueryAuthorizationError("固定输出的脱敏规则不可执行", "POLICY_REJECTED");
    return [parsed.data];
  });
  return {
    query: {
      ...query,
      parameters: [...parameters.values()],
      expected_output: rawColumns.map(({ name, data_type, nullable }) => ({
        name,
        data_type,
        nullable,
      })),
    },
    outputMasks,
  };
}

/** 保留所有叶子条件供绑定完整性检查；实际允许范围仍由原 AND/OR 树决定。 */
function flattenConditions(group: QueryFilterGroup) {
  const conditions: Array<Exclude<QueryFilterGroup["items"][number], QueryFilterGroup>> = [];
  for (const item of group.items) {
    if ("items" in item) conditions.push(...flattenConditions(item));
    else conditions.push(item);
  }
  return conditions;
}

/** 求值完整或部分字段组合；undefined 表示尚未赋值的字段仍可能改变真假结果。 */
function evaluatePermissionScope(
  group: QueryFilterGroup,
  values: Map<string, unknown>,
): boolean | undefined {
  const matches = (item: QueryFilterGroup["items"][number]): boolean | undefined => {
    if ("items" in item) return evaluatePermissionScope(item, values);
    if (!values.has(item.field)) return undefined;
    const value = values.get(item.field);
    return item.op === "eq"
      ? value === item.value
      : Array.isArray(item.value) && item.value.includes(value);
  };
  const results = group.items.map(matches);
  if (group.logic === "and") {
    if (results.includes(false)) return false;
    return results.includes(undefined) ? undefined : true;
  }
  if (results.includes(true)) return true;
  return results.includes(undefined) ? undefined : false;
}

/**
 * 对 eq/in 的有限等价类完整验证：所有可行组合对缺省字段必须给出同一个非空真实值。
 * 已确定为假的部分组合立即剪枝；多值和未列出值都要求显式参数，保持调用范围完整。
 */
function resolveUniquePermissionValues(
  group: QueryFilterGroup,
  fields: string[],
  candidates: unknown[][],
): Map<string, unknown> | undefined {
  let checked = 0;
  const values = new Map<string, unknown>();
  let result: Map<string, unknown> | undefined;
  const visit = (index: number): void => {
    checked += 1;
    if (checked > maxPermissionCombinations)
      throw new QueryAuthorizationError(
        "权限参数组合过多，请提供更明确的授权参数",
        "POLICY_REJECTED",
      );
    if (evaluatePermissionScope(group, values) === false) return;
    if (index === fields.length) {
      if (
        [...values.values()].some((value) => value === otherPermissionValue || value === null) ||
        (result && fields.some((field) => result!.get(field) !== values.get(field)))
      )
        throw new QueryAuthorizationError(
          "权限范围不能唯一确定标量参数，请明确提供授权参数",
          "POLICY_REJECTED",
        );
      result = new Map(values);
      return;
    }
    for (const value of candidates[index]) {
      values.set(fields[index], value);
      visit(index + 1);
    }
    values.delete(fields[index]);
  };
  visit(0);
  return result;
}

export { authorizeParameterizedQuery };
