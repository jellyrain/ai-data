import {
  publishedRelationInputSchema,
  relationPublishInputSchema,
  stableStringify,
  type CatalogRelation,
  type PublishedRelationInput,
  type RelationGraph,
  type RelationPublishInput,
} from "@ai-data/contracts";
import type { RelationView } from "./relation-draft-types";

/** 关系标识在源对象内唯一；入向展开不能交换关系的两端。 */
function relationKey(object: string, id: string) {
  return JSON.stringify([object, id]);
}
function changeKey(change: RelationPublishInput["changes"][number]) {
  return relationKey(
    change.object_id,
    change.action === "disable" ? change.relation_id : change.relation.relation_id,
  );
}
function relationInput(row: CatalogRelation): PublishedRelationInput {
  return publishedRelationInputSchema.parse({
    relation_id: row.relation_id,
    target_object_id: row.target_object_id,
    description: row.description,
    column_pairs: row.column_pairs,
    cardinality: row.cardinality,
    allowed_join_types: row.allowed_join_types,
  });
}
/** 回读某个对象的一层完整关系，保留画布已展开的其他分支。 */
function mergeRelations(current: CatalogRelation[], graph: RelationGraph) {
  const rows = new Map(
    current
      .filter(
        (row) => row.object_id !== graph.object_id && row.target_object_id !== graph.object_id,
      )
      .map((row) => [relationKey(row.object_id, row.relation_id), row]),
  );
  for (const row of [...graph.outgoing, ...graph.incoming])
    rows.set(relationKey(row.object_id, row.relation_id), row);
  return [...rows.values()];
}
function stageRelationChange(
  changes: RelationPublishInput["changes"],
  change: RelationPublishInput["changes"][number],
) {
  const key = changeKey(change);
  return relationPublishInputSchema.parse({
    changes: [...changes.filter((item) => changeKey(item) !== key), change],
  }).changes;
}
/** 待停用边继续显示以便核对；新边在发布前不拥有服务端版本。 */
function relationViews(
  source: string,
  rows: CatalogRelation[],
  changes: RelationPublishInput["changes"],
): RelationView[] {
  const views = new Map(
    rows.map((relation) => [
      relationKey(relation.object_id, relation.relation_id),
      { key: relationKey(relation.object_id, relation.relation_id), relation } as RelationView,
    ]),
  );
  for (const change of changes) {
    const key = changeKey(change),
      old = views.get(key)?.relation;
    if (change.action === "disable") {
      if (old) views.set(key, { key, change: "disable", relation: { ...old, enabled: false } });
    } else
      views.set(key, {
        key,
        change: change.action,
        relation: {
          source_id: source,
          object_id: change.object_id,
          version: old?.version ?? 0,
          updated_at: old?.updated_at ?? "",
          enabled: true,
          ...change.relation,
        },
      });
  }
  return [...views.values()];
}
/** 管理员明确核对后才采用最新版本；回执丢失时去除已经生效的操作。 */
function rebaseRelationChanges(
  changes: RelationPublishInput["changes"],
  latest: CatalogRelation[],
) {
  return changes.flatMap((change): RelationPublishInput["changes"] => {
    const row = latest.find(
      (item) => relationKey(item.object_id, item.relation_id) === changeKey(change),
    );
    if (change.action === "disable")
      return !row || !row.enabled ? [] : [{ ...change, expected_version: row.version }];
    if (row?.enabled && stableStringify(relationInput(row)) === stableStringify(change.relation))
      return [];
    if (change.action === "create") {
      if (row)
        throw new Error(`关系 ${change.relation.relation_id} 已存在，请撤销该项后重新创建。`);
      return [change];
    }
    if (!row) throw new Error(`关系 ${change.relation.relation_id} 已移除，请撤销该项后重新创建。`);
    return [{ ...change, expected_version: row.version }];
  });
}
export {
  relationKey,
  changeKey,
  relationInput,
  mergeRelations,
  stageRelationChange,
  relationViews,
  rebaseRelationChanges,
};
