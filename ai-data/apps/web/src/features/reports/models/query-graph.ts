import type { ReportDefinition } from "@ai-data/contracts";
import type { QueryGraph } from "./query-graph-types";

/** 稳定64位布局键，使长查询标识及别名组合仍满足布局ID长度合同。 */
function nodeId(queryId: string, alias: string): string {
  let hash = 14695981039346656037n;
  for (const character of JSON.stringify([queryId, alias]))
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return `node_${hash.toString(16)}`;
}
function graphForQuery(definition: ReportDefinition, queryId: string): QueryGraph {
  const item = definition.queries.find((q) => q.query_id === queryId);
  if (!item) return { nodes: [], edges: [] };
  const query = item.query;
  const objects =
    query.type === "metric_query"
      ? [{ alias: "metric", object_id: query.metric_id }]
      : [query.from, ...(query.type === "relational_query" ? query.joins : [])];
  const nodes: QueryGraph["nodes"] = objects.map((object, index) => {
    const id = nodeId(queryId, object.alias),
      stored = definition.editor_layout?.nodes.find((n) => n.id === id);
    return {
      id,
      type: "query",
      position: stored
        ? { x: stored.x, y: stored.y }
        : { x: 100 + index * 340, y: 140 + (index % 2) * 130 },
      data: {
        queryId,
        alias: object.alias,
        objectId: object.object_id,
        kind: query.type,
        primary: index === 0,
        columns:
          query.type === "relational_query"
            ? query.select
                .filter((c) => c.field.startsWith(`${object.alias}.`))
                .map((c) => c.as ?? c.field.split(".").slice(1).join("."))
            : [],
        conditions:
          query.type === "relational_query"
            ? ([query.from, ...query.joins].find((o) => o.alias === object.alias)?.filters?.items
                .length ?? 0)
            : 0,
      },
    };
  });
  const edges: QueryGraph["edges"] =
    query.type === "relational_query"
      ? query.joins.map((join) => ({
          id: `edge_${nodeId(queryId, join.alias)}`,
          source: nodeId(queryId, join.source_alias),
          target: nodeId(queryId, join.alias),
          type: "flowing",
          data: { relationId: join.relation_id, joinType: join.type, alias: join.alias },
          label: `${join.type.toUpperCase()} · ${join.relation_id}`,
        }))
      : [];
  return { nodes, edges };
}
function moveNode(
  definition: ReportDefinition,
  id: string,
  position: { x: number; y: number },
): ReportDefinition {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return definition;
  return {
    ...definition,
    editor_layout: {
      nodes: [
        ...(definition.editor_layout?.nodes ?? []).filter((n) => n.id !== id),
        { id, x: position.x, y: position.y },
      ],
    },
  };
}
export { nodeId, graphForQuery, moveNode };
