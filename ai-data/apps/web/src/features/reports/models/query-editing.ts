import type { Dataset, CatalogRelation, ReportDefinition } from "@ai-data/contracts";
import type { RelationalReportQuery, EditorField, FilterGroup } from "./definition-editor-types";
import { cloneDefinition, uniqueId } from "./definition-editor";
import { nodeId } from "./query-graph";

/** 外层查询使用预聚合输出；对象预过滤使用原始列。 */
function queryFields(
  query: RelationalReportQuery,
  datasets: Dataset[],
  alias?: string,
  raw = false,
): EditorField[] {
  return [query.from, ...query.joins]
    .filter((o) => !alias || o.alias === alias)
    .flatMap((object) => {
      const dataset = datasets.find((d) => d.object_id === object.object_id);
      if (!dataset) return [];
      if (!raw && object.pre_aggregate)
        return object.pre_aggregate.select.map((column) => {
          const original = dataset.columns.find(
            (c) => `${object.alias}.${c.name}` === column.field,
          );
          return {
            name: `${object.alias}.${column.as}`,
            label: `${object.alias}.${column.as}`,
            dataType: column.aggregation?.startsWith("count")
              ? "integer"
              : (original?.data_type ?? "decimal"),
          };
        });
      return dataset.columns.map((column) => ({
        name: `${object.alias}.${column.name}`,
        label: `${object.alias}.${column.name}${column.source_description ? ` · ${column.source_description}` : ""}`,
        dataType: column.data_type,
        operators: dataset.query_capabilities?.filter_conditions?.find(
          (c) => c.name === column.name,
        )?.allowed_ops,
      }));
    });
}
/** 一个对象对应一条入向连接；替换连接必须保留拓扑顺序及批准方向。 */
function connectRelation(
  input: RelationalReportQuery,
  sourceAlias: string,
  relation: CatalogRelation,
  joinType: "inner" | "left" | "right",
  targetAlias?: string,
): RelationalReportQuery {
  const query = JSON.parse(JSON.stringify(input)) as RelationalReportQuery;
  const objects = [query.from, ...query.joins],
    sourceIndex = objects.findIndex((o) => o.alias === sourceAlias),
    source = objects[sourceIndex];
  if (
    !source ||
    relation.source_id !== query.source_id ||
    relation.object_id !== source.object_id ||
    !relation.enabled ||
    !relation.allowed_join_types.includes(joinType)
  )
    throw new Error("所选关系的方向或连接方式不可用");
  if (targetAlias) {
    const targetIndex = objects.findIndex((o) => o.alias === targetAlias),
      target = query.joins.find((j) => j.alias === targetAlias);
    if (!target || targetIndex <= sourceIndex || target.object_id !== relation.target_object_id)
      throw new Error("连接必须从已有对象指向后续的匹配对象");
    Object.assign(target, {
      source_alias: sourceAlias,
      relation_id: relation.relation_id,
      type: joinType,
    });
  } else {
    if (query.joins.length >= 50) throw new Error("每个查询最多50条关联");
    query.joins.push({
      alias: uniqueId(
        "t",
        objects.map((o) => o.alias),
      ),
      object_id: relation.target_object_id,
      source_alias: sourceAlias,
      relation_id: relation.relation_id,
      type: joinType,
    });
  }
  return query;
}
function withoutFields(
  group: FilterGroup | undefined,
  removed: Set<string>,
): FilterGroup | undefined {
  if (!group) return undefined;
  return {
    ...group,
    items: group.items.flatMap<FilterGroup["items"][number]>((item) => {
      if ("logic" in item) {
        const child = withoutFields(item, removed)!;
        return child.items.length ? [child] : [];
      }
      return removed.has(item.field.split(".")[0]!) ? [] : [item];
    }),
  };
}
/** 删除对象前由页面确认级联影响；保留不依赖该对象的条件和输出。 */
function removeObject(input: ReportDefinition, queryId: string, alias: string): ReportDefinition {
  const value = cloneDefinition(input),
    item = value.queries.find((q) => q.query_id === queryId);
  if (!item || item.query.type !== "relational_query") return value;
  const query = item.query;
  if (query.from.alias === alias) throw new Error("主对象需要通过删除整个查询移除");
  const removed = new Set([alias]);
  for (const join of query.joins) if (removed.has(join.source_alias)) removed.add(join.alias);
  const refers = (field: string) => removed.has(field.split(".")[0]!);
  query.joins = query.joins.filter((j) => !removed.has(j.alias));
  query.select = query.select.filter((s) => !refers(s.field));
  query.group_by = query.group_by.filter((f) => !refers(f));
  query.order_by = query.order_by.filter((o) => !refers(o.field));
  query.filters = withoutFields(query.filters, removed)!;
  for (const object of [query.from, ...query.joins])
    object.filters = withoutFields(object.filters, removed);
  for (const join of query.joins) join.on_filters = withoutFields(join.on_filters, removed);
  item.bindings = item.bindings.filter(
    (b) =>
      b.target.type !== "filter" || (!refers(b.target.field) && !removed.has(b.target.alias ?? "")),
  );
  value.block_references = value.block_references.filter(
    (ref) => !Object.values(ref.query_id_map).includes(queryId),
  );
  if (value.editor_layout)
    value.editor_layout.nodes = value.editor_layout.nodes.filter(
      (n) => ![...removed].some((a) => nodeId(queryId, a) === n.id),
    );
  return value;
}
/** 用户确认更换主对象后，从新目录重建字段；查询ID和展示顺序仍保持。 */
function replacePrimary(
  input: ReportDefinition,
  queryId: string,
  dataset: Dataset,
): ReportDefinition {
  const value = cloneDefinition(input),
    item = value.queries.find((q) => q.query_id === queryId);
  if (!item || item.query.type === "metric_query") return value;
  const alias = item.query.from.alias;
  const oldAliases = [
    alias,
    ...(item.query.type === "relational_query" ? item.query.joins.map((j) => j.alias) : []),
  ];
  item.query = ["table", "view"].includes(dataset.kind)
    ? {
        type: "relational_query",
        source_id: dataset.source_id,
        from: { object_id: dataset.object_id, alias },
        joins: [],
        select: dataset.columns
          .slice(0, 5)
          .map((c) => ({ field: `${alias}.${c.name}`, as: c.name })),
        filters: { logic: "and", items: [] },
        group_by: [],
        order_by: [],
        limit: 1000,
      }
    : {
        type: "parameterized_query",
        source_id: dataset.source_id,
        from: { object_id: dataset.object_id, alias },
        parameters: dataset.query_parameters
          .filter((p) => p.default_value !== undefined)
          .map((p) => ({ name: p.name, data_type: p.data_type, value: p.default_value })),
        limit: 1000,
      };
  item.bindings = [];
  const columns = dataset.columns.map((c) => c.name);
  for (const block of value.presentation.flatMap((s) => s.blocks))
    if (block.query_ids.includes(queryId)) {
      const retained = block.columns?.filter((c) => columns.includes(c));
      block.columns = retained?.length ? retained : undefined;
      if (block.chart)
        block.chart = {
          ...block.chart,
          x: columns.includes(block.chart.x) ? block.chart.x : (columns[0] ?? ""),
          y: columns.includes(block.chart.y) ? block.chart.y : (columns[1] ?? columns[0] ?? ""),
        };
    }
  value.block_references = value.block_references.filter(
    (ref) => !Object.values(ref.query_id_map).includes(queryId),
  );
  if (value.editor_layout)
    value.editor_layout.nodes = value.editor_layout.nodes.filter(
      (n) => !oldAliases.slice(1).some((a) => nodeId(queryId, a) === n.id),
    );
  return value;
}
export { queryFields, connectRelation, removeObject, replacePrimary };
