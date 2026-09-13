import type { QueryAccessContext } from "@ai-data/contracts";

import type { AuthContext } from "../auth/auth-types";
import { validateUniqueKeys } from "../catalog/relation-config";
import { QueryAuthorizationError } from "./query-authorization-error";
import type {
  AuthorizedField,
  QueryFilterGroup,
  QueryRelation,
  RelationalQuery,
  RelationScopes,
} from "./query-authorization-types";

/** 查找当前层已授权字段；别名和投影来源在建作用域时固定。 */
function resolveField(fields: Map<string, AuthorizedField>, reference: string): AuthorizedField {
  const field = fields.get(reference);
  if (!field)
    throw new QueryAuthorizationError(`字段无权访问: ${reference}`, "UNAUTHORIZED_COLUMN");
  return field;
}

/** 构建原始字段和派生投影两种作用域，并逐层验证聚合与分组能力。 */
function buildRelationScopes(
  query: RelationalQuery,
  relations: Map<string, QueryRelation>,
  context: AuthContext,
): RelationScopes {
  const rawFields = new Map<string, AuthorizedField>();
  const fields = new Map<string, AuthorizedField>();
  const uniqueKeys = new Map<string, string[][]>();
  for (const ref of [query.from, ...query.joins]) {
    const relation = relations.get(ref.alias)!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.alias))
      throw new QueryAuthorizationError("查询别名必须为单段安全名称", "INVALID_INPUT");
    if (!["table", "view"].includes(relation.authorized.dataset.kind))
      throw new QueryAuthorizationError("关系查询仅支持表或视图", "UNSUPPORTED_QUERY");
    const keys = validateUniqueKeys(
      relation.config,
      relation.authorized.rawColumns,
      "POLICY_REJECTED",
    );
    for (const column of relation.authorized.dataset.columns) {
      const field = { alias: ref.alias, sourceName: column.name, dataType: column.data_type };
      rawFields.set(`${ref.alias}.${column.name}`, field);
      if (!ref.pre_aggregate) fields.set(`${ref.alias}.${column.name}`, field);
    }
    if (!ref.pre_aggregate) {
      uniqueKeys.set(ref.alias, keys);
      continue;
    }
    const local = (reference: string) => {
      const field = resolveField(rawFields, reference);
      if (field.alias !== ref.alias)
        throw new QueryAuthorizationError("预聚合仅能引用所属对象字段", "UNAUTHORIZED_COLUMN");
      return field;
    };
    for (const reference of ref.pre_aggregate.group_by)
      assertFieldCapability(local(reference), relation, "groupable_fields");
    for (const item of ref.pre_aggregate.select) {
      const input = local(item.field);
      const dataType = item.aggregation
        ? assertAggregation(input, item.aggregation, relation, context)
        : input.dataType;
      fields.set(`${ref.alias}.${item.as}`, {
        ...input,
        dataType,
        inputAggregation: item.aggregation,
      });
    }
    // 唯一性来自本次完整分组元组；同一分组字段的多个输出名均保留等价来源。
    uniqueKeys.set(ref.alias, [
      ref.pre_aggregate.group_by.map((reference) => local(reference).sourceName),
    ]);
  }
  return { rawFields, fields, uniqueKeys };
}

/** 所有字段沿来源继承 DAS 与 API 的分组、排序限制，派生表达式不能扩大这些操作能力。 */
function assertFieldCapability(
  field: AuthorizedField,
  relation: QueryRelation,
  kind: "groupable_fields" | "sortable_fields",
): void {
  for (const capability of [
    relation.authorized.rawQueryCapabilities,
    relation.authorized.dataset.query_capabilities,
  ]) {
    if (capability?.[kind] && !capability[kind].includes(field.sourceName))
      throw new QueryAuthorizationError(
        `字段不允许${kind === "groupable_fields" ? "分组" : "排序"}: ${field.alias}.${field.sourceName}`,
        "UNSUPPORTED_QUERY",
      );
  }
}

/** 先核对输入类型和批准函数；派生度量保留显式嵌套聚合语义，返回其可信输出类型。 */
function assertAggregation(
  field: AuthorizedField,
  aggregation: NonNullable<RelationalQuery["select"][number]["aggregation"]>,
  relation: QueryRelation,
  context: AuthContext,
): AuthorizedField["dataType"] {
  const isNumeric = field.dataType === "integer" || field.dataType === "decimal";
  if (
    ((aggregation === "sum" || aggregation === "avg") && !isNumeric) ||
    ((aggregation === "min" || aggregation === "max") &&
      ["buffer", "boolean"].includes(field.dataType))
  )
    throw new QueryAuthorizationError("聚合函数与输入字段类型不匹配", "UNSUPPORTED_QUERY");
  if (!field.inputAggregation) {
    for (const capability of [
      relation.authorized.rawQueryCapabilities,
      relation.authorized.dataset.query_capabilities,
    ]) {
      if (
        capability?.aggregations &&
        !capability.aggregations.some(
          (item) => item.field === field.sourceName && item.functions.includes(aggregation),
        )
      )
        throw new QueryAuthorizationError(
          `字段不允许聚合: ${field.alias}.${field.sourceName}`,
          "UNSUPPORTED_QUERY",
        );
    }
  }
  const dataType =
    aggregation === "count" || aggregation === "count_distinct"
      ? "integer"
      : aggregation === "avg"
        ? "decimal"
        : field.dataType;
  if (resolveMask(field, relation, context) && dataType !== "string")
    throw new QueryAuthorizationError("聚合结果无法应用源字段字符串脱敏策略", "POLICY_REJECTED");
  return dataType;
}

/** 值使用当前层真实类型，操作授权沿原字段来源同时接受 DAS 与 API 限制。 */
function validateFilters(
  group: QueryFilterGroup,
  fields: Map<string, AuthorizedField>,
  relations: Map<string, QueryRelation>,
  ownAlias?: string,
): void {
  for (const item of group.items) {
    if ("items" in item) {
      validateFilters(item, fields, relations, ownAlias);
      continue;
    }
    const field = resolveField(fields, item.field);
    if (ownAlias && field.alias !== ownAlias)
      throw new QueryAuthorizationError("对象过滤只能引用所属别名的字段", "UNAUTHORIZED_COLUMN");
    if (field.dataType !== item.data_type)
      throw new QueryAuthorizationError("过滤类型与目录字段类型不匹配", "UNSUPPORTED_QUERY");
    const relation = relations.get(field.alias)!;
    const sourceType = relation.authorized.rawColumns.find(
      (column) => column.name === field.sourceName,
    )?.data_type;
    for (const capability of [
      relation.authorized.rawQueryCapabilities,
      relation.authorized.dataset.query_capabilities,
    ]) {
      if (
        capability?.filter_conditions &&
        !capability.filter_conditions.some(
          (definition) =>
            definition.name === field.sourceName &&
            definition.data_type === sourceType &&
            definition.allowed_ops.includes(item.op),
        )
      )
        throw new QueryAuthorizationError(`字段不允许当前过滤: ${item.field}`, "UNSUPPORTED_QUERY");
    }
  }
}

/** 脱敏始终按原始字段寻找策略，内部和最终输出的改名均不能改变权限来源。 */
function resolveMask(
  field: AuthorizedField,
  relation: QueryRelation,
  context: AuthContext,
): QueryAccessContext["output_masks"][number]["rule"] | undefined {
  const policy = relation.config?.column_policies.find((item) => item.field === field.sourceName);
  if (
    !policy ||
    policy.default_masking.type === "none" ||
    policy.unmasked_role_ids.some((roleId) => context.roleIds?.includes(roleId))
  )
    return undefined;
  return policy.default_masking;
}

export {
  assertAggregation,
  assertFieldCapability,
  buildRelationScopes,
  resolveField,
  resolveMask,
  validateFilters,
};
