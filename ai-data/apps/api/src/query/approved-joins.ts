import { QueryAuthorizationError } from "./query-authorization-error";
import { validateRelationConfig, validateUniqueKeys } from "../catalog/relation-config";
import type {
  AuthorizedField,
  AuthorizedJoin,
  QueryRelation,
  RelationalQuery,
} from "./query-authorization-types";

/** 按加入顺序匹配一条完整批准关系，要求所有列对都连接同一既有对象与当前对象。 */
function assertApprovedJoins(
  query: RelationalQuery,
  relations: Map<string, QueryRelation>,
  assertField: (field: string) => AuthorizedField,
): AuthorizedJoin[] {
  const availableAliases = new Set([query.from.alias]);
  const result: AuthorizedJoin[] = [];
  for (const join of query.joins) {
    const sourceAlias = join.on[0].left.split(".")[0];
    const source = relations.get(sourceAlias);
    const pairs = join.on.map((condition) => {
      const left = condition.left.split(".");
      const right = condition.right.split(".");
      if (
        left.length !== 2 ||
        right.length !== 2 ||
        left[0] !== sourceAlias ||
        right[0] !== join.alias ||
        !availableAliases.has(sourceAlias)
      )
        throw new QueryAuthorizationError("Join 引用的对象别名无效", "UNAUTHORIZED_OBJECT");
      const leftField = assertField(condition.left);
      const rightField = assertField(condition.right);
      if (leftField.inputAggregation || rightField.inputAggregation)
        throw new QueryAuthorizationError(
          "聚合输出不能作为批准关系的原始字段",
          "UNAUTHORIZED_OBJECT",
        );
      if (leftField.dataType !== rightField.dataType)
        throw new QueryAuthorizationError("Join 两侧字段类型必须一致", "POLICY_REJECTED");
      return JSON.stringify([leftField.sourceName, rightField.sourceName]);
    });
    const submittedPairs = new Set(pairs);
    const allowed =
      submittedPairs.size === join.on.length &&
      source?.config?.approved_relations.find((relation) => {
        if (
          relation.target_object_id !== join.object_id ||
          (join.relation_id !== undefined && relation.relation_id !== join.relation_id) ||
          relation.column_pairs.length !== pairs.length
        )
          return false;
        const expectedPairs = new Set(
          relation.column_pairs.map((pair) =>
            JSON.stringify([pair.source_column, pair.target_column]),
          ),
        );
        return (
          expectedPairs.size === pairs.length && pairs.every((pair) => expectedPairs.has(pair))
        );
      });
    if (!allowed)
      throw new QueryAuthorizationError("Join 未匹配已批准的完整业务关系", "UNAUTHORIZED_OBJECT");
    const target = relations.get(join.alias)!;
    validateRelationConfig(
      allowed,
      source!.authorized.rawColumns,
      target.authorized.rawColumns,
      validateUniqueKeys(source!.config, source!.authorized.rawColumns, "POLICY_REJECTED"),
      validateUniqueKeys(target.config, target.authorized.rawColumns, "POLICY_REJECTED"),
      "POLICY_REJECTED",
    );
    result.push({
      sourceAlias,
      targetAlias: join.alias,
      sourceFields: join.on.map((condition) => assertField(condition.left).sourceName),
      targetFields: join.on.map((condition) => assertField(condition.right).sourceName),
      relation: allowed,
    });
    availableAliases.add(join.alias);
  }
  return result;
}

export { assertApprovedJoins };
