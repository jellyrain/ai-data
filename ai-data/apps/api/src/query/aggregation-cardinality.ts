import { coversUniqueKey } from "../catalog/relation-config";
import { QueryAuthorizationError } from "./query-authorization-error";
import type {
  AuthorizedJoin,
  QueryRelation,
  RelationalQuery,
  RelationScopes,
} from "./query-authorization-types";
import { resolveField } from "./relational-fields";

/**
 * 按 left-deep Join 顺序传播扩行风险。右侧键不唯一会扩展所有既有输入；
 * 新输入仅在左侧关联键唯一且该左别名此前未被扩展时保持单次出现。
 * 唯一键是审核声明，预聚合关系则采用本次完整分组元组。
 */
function assertAggregationCardinality(
  query: RelationalQuery,
  joins: AuthorizedJoin[],
  relations: Map<string, QueryRelation>,
  scopes: RelationScopes,
): void {
  const refs = [query.from, ...query.joins];
  const isStatistical =
    query.select.some((item) => item.aggregation) ||
    refs.some((ref) => ref.pre_aggregate?.select.some((item) => item.aggregation));
  if (!isStatistical || !joins.length) return;
  const hasKeyEvidence = (alias: string) =>
    refs.some((ref) => ref.alias === alias && ref.pre_aggregate) ||
    Boolean(relations.get(alias)?.config?.unique_keys?.length);
  const expanded = new Map<string, boolean>([[query.from.alias, false]]);
  for (const join of joins) {
    if (
      !join.relation.cardinality &&
      !(hasKeyEvidence(join.sourceAlias) && hasKeyEvidence(join.targetAlias))
    )
      throw new QueryAuthorizationError(
        "关联统计需要已审核基数或双方唯一键依据",
        "UNSUPPORTED_QUERY",
      );
    const sourceWasExpanded = expanded.get(join.sourceAlias)!;
    const leftUnique = coversUniqueKey(join.sourceFields, scopes.uniqueKeys.get(join.sourceAlias)!);
    const rightUnique = coversUniqueKey(
      join.targetFields,
      scopes.uniqueKeys.get(join.targetAlias)!,
    );
    if (!rightUnique) {
      for (const alias of expanded.keys()) expanded.set(alias, true);
    }
    expanded.set(join.targetAlias, sourceWasExpanded || !leftUnique);
  }
  for (const item of query.select) {
    const field = resolveField(scopes.fields, item.field);
    const operation = item.aggregation ?? field.inputAggregation;
    if (operation && ["sum", "count", "avg"].includes(operation) && expanded.get(field.alias))
      throw new QueryAuthorizationError(
        "关联会重复统计输入，请按已审核粒度显式预聚合",
        "UNSUPPORTED_QUERY",
      );
  }
}

export { assertAggregationCardinality };
