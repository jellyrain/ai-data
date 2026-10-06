import { stableStringify, type MetricDefinition, type CatalogRelation } from "@ai-data/contracts";
import type { RelationalReportQuery } from "../../reports/models/definition-editor-types";
/** 将指标字段对映射到已授权关系；无法唯一匹配时保留原稿并要求核对关系。 */
function metricQueryToEditor(
  query: MetricDefinition["query"],
  relations: CatalogRelation[],
): RelationalReportQuery {
  const aliases = new Map([[query.from.alias, query.from.object_id]]);
  const joins: RelationalReportQuery["joins"] = [];
  for (const join of query.joins) {
    const actual = join.on
      .map((pair) =>
        pair.left.startsWith(join.alias + ".")
          ? pair.right + "=" + pair.left
          : pair.left + "=" + pair.right,
      )
      .sort();
    const matches = [...aliases].flatMap(([alias, object]) =>
      relations
        .filter(
          (relation) =>
            relation.enabled &&
            relation.source_id === query.source_id &&
            relation.object_id === object &&
            relation.target_object_id === join.object_id &&
            relation.allowed_join_types.includes(join.type) &&
            (!join.relation_id || relation.relation_id === join.relation_id) &&
            stableStringify(
              relation.column_pairs
                .map(
                  (pair) =>
                    alias + "." + pair.source_column + "=" + join.alias + "." + pair.target_column,
                )
                .sort(),
            ) === stableStringify(actual),
        )
        .map((relation) => ({ alias, relation })),
    );
    if (matches.length !== 1) throw new Error("指标关联无法唯一对应当前已发布关系，请核对关系目录");
    const { on: _on, ...fields } = join;
    void _on;
    joins.push({
      ...fields,
      relation_id: matches[0]!.relation.relation_id,
      source_alias: matches[0]!.alias,
    });
    aliases.set(join.alias, join.object_id);
  }
  return { ...query, joins };
}
/** 报表编辑关系转换为指标字段对，最终保存继续由 API 校验完整查询权限。 */
function editorQueryToMetric(
  query: RelationalReportQuery,
  relations: CatalogRelation[],
): MetricDefinition["query"] {
  const aliases = new Map([[query.from.alias, query.from.object_id]]);
  const joins: MetricDefinition["query"]["joins"] = [];
  for (const edge of query.joins) {
    const object = aliases.get(edge.source_alias);
    const relation = relations.find(
      (relation) =>
        relation.enabled &&
        relation.source_id === query.source_id &&
        relation.object_id === object &&
        relation.relation_id === edge.relation_id &&
        relation.target_object_id === edge.object_id &&
        relation.allowed_join_types.includes(edge.type),
    );
    if (!relation || aliases.has(edge.alias))
      throw new Error("关联已失效或连接顺序变化，请重新选择关系");
    const { source_alias, ...join } = edge;
    joins.push({
      ...join,
      on: relation.column_pairs.map((pair) => ({
        left: source_alias + "." + pair.source_column,
        op: "eq",
        right: edge.alias + "." + pair.target_column,
      })),
    });
    aliases.set(edge.alias, edge.object_id);
  }
  return { ...query, joins };
}
export { metricQueryToEditor, editorQueryToMetric };
