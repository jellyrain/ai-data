import type { QueryAccessContext } from "@ai-data/contracts";

import type { AuthContext } from "../auth/auth-types";
import { assertApprovedJoins } from "./approved-joins";
import { assertAggregationCardinality } from "./aggregation-cardinality";
import { QueryAuthorizationError } from "./query-authorization-error";
import type { QueryRelation, RelationalQuery } from "./query-authorization-types";
import {
  assertAggregation,
  assertFieldCapability,
  buildRelationScopes,
  resolveField,
  resolveMask,
  validateFilters,
} from "./relational-fields";
import { buildObjectFilters } from "./row-policy-filters";

/** 验证每层字段、完整业务关联及统计基数，把对象权限留在原始输入预过滤。 */
function authorizeRelationalQuery(
  query: RelationalQuery,
  relations: Map<string, QueryRelation>,
  context: AuthContext,
): { query: RelationalQuery; outputMasks: QueryAccessContext["output_masks"] } {
  const scopes = buildRelationScopes(query, relations, context);
  const assertField = (reference: string) => resolveField(scopes.fields, reference);
  const groupFields = new Set(query.group_by);
  const isGrouped = groupFields.size > 0 || query.select.some((item) => item.aggregation);
  const outputNames = new Map<string, RelationalQuery["select"][number]>();
  const outputMasks: QueryAccessContext["output_masks"] = [];
  for (const item of query.select) {
    const field = assertField(item.field);
    const relation = relations.get(field.alias)!;
    const resultName = item.as ?? item.field.replaceAll(".", "_");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(resultName) || outputNames.has(resultName))
      throw new QueryAuthorizationError("结果字段别名必须为唯一的单段安全名称", "INVALID_INPUT");
    outputNames.set(resultName, item);
    if (isGrouped && !item.aggregation && !groupFields.has(item.field))
      throw new QueryAuthorizationError("聚合查询的普通输出字段必须属于分组", "UNSUPPORTED_QUERY");
    const dataType = item.aggregation
      ? assertAggregation(field, item.aggregation, relation, context)
      : field.dataType;
    const rule = resolveMask(field, relation, context);
    if (rule) {
      if (dataType !== "string")
        throw new QueryAuthorizationError("输出类型无法执行源字段脱敏策略", "POLICY_REJECTED");
      outputMasks.push({ result_column: resultName, rule });
    }
  }
  for (const reference of query.group_by) {
    const field = assertField(reference);
    assertFieldCapability(field, relations.get(field.alias)!, "groupable_fields");
  }
  for (const item of query.order_by) {
    const output = outputNames.get(item.field);
    const field = assertField(output?.field ?? item.field);
    if (isGrouped && !output && !groupFields.has(item.field))
      throw new QueryAuthorizationError("聚合查询只能按分组字段或结果列排序", "UNSUPPORTED_QUERY");
    assertFieldCapability(field, relations.get(field.alias)!, "sortable_fields");
  }
  validateFilters(query.filters, scopes.fields, relations);
  const availableAliases = new Set([query.from.alias]);
  for (const join of query.joins) {
    availableAliases.add(join.alias);
    if (join.on_filters) {
      const fields = new Map(
        [...scopes.fields].filter(([, field]) => availableAliases.has(field.alias)),
      );
      validateFilters(join.on_filters, fields, relations);
    }
  }
  const joins = assertApprovedJoins(query, relations, assertField);
  assertAggregationCardinality(query, joins, relations, scopes);
  const authorizeObject = <T extends RelationalQuery["from"]>(ref: T): T => {
    if (ref.filters) validateFilters(ref.filters, scopes.rawFields, relations, ref.alias);
    const relation = relations.get(ref.alias)!;
    const filters = buildObjectFilters(ref.alias, relation.authorized, context, ref.filters);
    if (filters) validateFilters(filters, scopes.rawFields, relations, ref.alias);
    return { ...ref, ...(filters ? { filters } : {}) };
  };
  return {
    query: { ...query, from: authorizeObject(query.from), joins: query.joins.map(authorizeObject) },
    outputMasks,
  };
}

export { authorizeRelationalQuery };
