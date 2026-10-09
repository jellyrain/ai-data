import { reportDefinitionSchema } from "@ai-data/contracts";
import type { ReportDefinition, ReportQueryItem } from "@ai-data/contracts";
import type { FilterGroup } from "./definition-editor-types";
import { nodeId } from "./query-graph";

/** 草稿可以暂时没有查询和分区，提交时必须通过完整定义校验。 */
function blankDefinition(): ReportDefinition {
  return {
    title: "未命名报表",
    parameters: [],
    queries: [],
    presentation: [],
    block_references: [],
  };
}
/** 定义由JSON合同约束，克隆时解除Vue代理并与基准快照隔离。 */
function cloneDefinition(value: ReportDefinition): ReportDefinition {
  return JSON.parse(JSON.stringify(value)) as ReportDefinition;
}
function definitionIssues(value: ReportDefinition): string[] {
  const parsed = reportDefinitionSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(" / ") || "报表"}：${issue.message}`);
}
function uniqueId(prefix: string, used: Iterable<string>): string {
  const names = new Set(used);
  let index = 1;
  while (names.has(`${prefix}_${index}`)) index++;
  return `${prefix}_${index}`;
}
function validName(name: string, used: string[]): void {
  if (!/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.$]*$/u.test(name) || name.length > 128)
    throw new Error("标识需以字母或下划线开头，最长128个字符");
  if (used.includes(name)) throw new Error("标识已经存在");
}
function renameParameter(
  input: ReportDefinition,
  previous: string,
  next: string,
): ReportDefinition {
  if (previous === next) return input;
  validName(
    next,
    input.parameters.filter((p) => p.name !== previous).map((p) => p.name),
  );
  const value = cloneDefinition(input);
  for (const parameter of value.parameters) if (parameter.name === previous) parameter.name = next;
  for (const query of value.queries)
    for (const binding of query.bindings)
      if (binding.parameter === previous) binding.parameter = next;
  for (const ref of value.block_references)
    for (const key of Object.keys(ref.parameter_map))
      if (ref.parameter_map[key] === previous) ref.parameter_map[key] = next;
  return value;
}
function renameQuery(input: ReportDefinition, previous: string, next: string): ReportDefinition {
  if (previous === next) return input;
  validName(
    next,
    input.queries.filter((q) => q.query_id !== previous).map((q) => q.query_id),
  );
  const value = cloneDefinition(input),
    query = value.queries.find((q) => q.query_id === previous);
  if (!query) return value;
  query.query_id = next;
  for (const section of value.presentation)
    for (const block of section.blocks)
      block.query_ids = block.query_ids.map((id) => (id === previous ? next : id));
  for (const ref of value.block_references)
    for (const key of Object.keys(ref.query_id_map))
      if (ref.query_id_map[key] === previous) ref.query_id_map[key] = next;
  const aliases =
    query.query.type === "metric_query"
      ? ["metric"]
      : [
          query.query.from.alias,
          ...(query.query.type === "relational_query" ? query.query.joins.map((j) => j.alias) : []),
        ];
  for (const alias of aliases)
    for (const position of value.editor_layout?.nodes ?? [])
      if (position.id === nodeId(previous, alias)) position.id = nodeId(next, alias);
  return value;
}
function mapFilters(group: FilterGroup | undefined, field: (value: string) => string): void {
  for (const condition of group?.items ?? []) {
    if ("logic" in condition) mapFilters(condition, field);
    else condition.field = field(condition.field);
  }
}
/** 修改结构化字段引用，过滤值和说明文字保持原值。 */
function renameAlias(
  input: ReportDefinition,
  queryId: string,
  previous: string,
  next: string,
): ReportDefinition {
  const value = cloneDefinition(input),
    item = value.queries.find((q) => q.query_id === queryId);
  if (!item || item.query.type === "metric_query" || previous === next) return value;
  const query = item.query;
  const objects = [query.from, ...(query.type === "relational_query" ? query.joins : [])];
  validName(
    next,
    objects.filter((o) => o.alias !== previous).map((o) => o.alias),
  );
  const field = (name: string) =>
    name.startsWith(`${previous}.`) ? `${next}${name.slice(previous.length)}` : name;
  for (const object of objects) {
    if (object.alias === previous) object.alias = next;
  }
  if (query.type === "relational_query") {
    const outputs = new Map(
      query.select
        .filter((column) => !column.as)
        .map((column) => [
          column.field.replaceAll(".", "_"),
          field(column.field).replaceAll(".", "_"),
        ]),
    );
    for (const block of value.presentation.flatMap((section) => section.blocks)) {
      if (!block.query_ids.includes(queryId)) continue;
      if (block.columns) block.columns = block.columns.map((name) => outputs.get(name) ?? name);
      if (block.chart) {
        block.chart.x = outputs.get(block.chart.x) ?? block.chart.x;
        block.chart.y = outputs.get(block.chart.y) ?? block.chart.y;
      }
    }
    for (const join of query.joins) {
      if (join.source_alias === previous) join.source_alias = next;
      mapFilters(join.on_filters, field);
    }
    for (const object of [query.from, ...query.joins]) {
      mapFilters(object.filters, field);
      if (object.pre_aggregate) {
        object.pre_aggregate.group_by = object.pre_aggregate.group_by.map(field);
        object.pre_aggregate.select.forEach((column) => {
          column.field = field(column.field);
        });
      }
    }
    mapFilters(query.filters, field);
    query.select.forEach((column) => {
      column.field = field(column.field);
    });
    query.order_by.forEach((column) => {
      column.field = field(column.field);
    });
    query.group_by = query.group_by.map(field);
  }
  for (const binding of item.bindings)
    if (binding.target.type === "filter") {
      binding.target.field = field(binding.target.field);
      if (binding.target.alias === previous) binding.target.alias = next;
    }
  for (const position of value.editor_layout?.nodes ?? [])
    if (position.id === nodeId(queryId, previous)) position.id = nodeId(queryId, next);
  return value;
}
function removeParameter(input: ReportDefinition, name: string): ReportDefinition {
  const value = cloneDefinition(input);
  value.parameters = value.parameters.filter((p) => p.name !== name);
  for (const item of value.queries)
    item.bindings = item.bindings.filter((b) => b.parameter !== name);
  value.block_references = value.block_references.filter(
    (ref) => !Object.values(ref.parameter_map).includes(name),
  );
  return value;
}
function removeQuery(input: ReportDefinition, id: string): ReportDefinition {
  const value = cloneDefinition(input),
    query = value.queries.find((q) => q.query_id === id);
  value.queries = value.queries.filter((q) => q.query_id !== id);
  value.presentation = value.presentation
    .map((section) => ({
      ...section,
      blocks: section.blocks
        .map((block) => ({ ...block, query_ids: block.query_ids.filter((q) => q !== id) }))
        .filter((block) => block.query_ids.length),
    }))
    .filter((section) => section.blocks.length);
  value.block_references = value.block_references.filter(
    (ref) => !Object.values(ref.query_id_map).includes(id),
  );
  if (query && value.editor_layout) {
    const aliases =
      query.query.type === "metric_query"
        ? ["metric"]
        : [
            query.query.from.alias,
            ...(query.query.type === "relational_query"
              ? query.query.joins.map((j) => j.alias)
              : []),
          ];
    value.editor_layout.nodes = value.editor_layout.nodes.filter(
      (n) => !aliases.some((a) => nodeId(id, a) === n.id),
    );
  }
  return value;
}
/** 首个查询建立报表展示；后续查询用于数据编排，由用户选择展示来源。 */
function appendQuery(
  input: ReportDefinition,
  item: ReportQueryItem,
  title: string,
): ReportDefinition {
  const value = cloneDefinition(input);
  value.queries.push(item);
  if (value.presentation.some((section) => section.blocks.some((block) => block.type !== "text")))
    return value;
  if (!value.presentation.length)
    value.presentation.push({ section_id: "main", title: "分析结果", blocks: [] });
  const block_id = uniqueId(
    "block",
    value.presentation.flatMap((s) => s.blocks.map((b) => b.block_id)),
  );
  value.presentation[0]!.blocks.push({
    block_id,
    type: "table",
    title,
    query_ids: [item.query_id],
  });
  return value;
}
export {
  blankDefinition,
  cloneDefinition,
  definitionIssues,
  uniqueId,
  renameParameter,
  renameQuery,
  renameAlias,
  removeParameter,
  removeQuery,
  appendQuery,
};
