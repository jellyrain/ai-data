/** 工具展示仅提取已校验参数和已授权输出的定位信息，正文与数据行由各自证据展示。 */
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  return text.length <= 4000 ? text : `${text.slice(0, 3980)}\n…摘要已省略`;
}
function fields(value: unknown, names: string[]) {
  const source = object(value);
  return Object.fromEntries(
    names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]),
  );
}
function queryStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(queryStructure);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      ["value", "values"].includes(key) ? "参数值已保护" : queryStructure(child),
    ]),
  );
}
/** 从已通过工具合同校验的参数提取定位信息；查询值继续保留在受权限检查的证据内。 */
function toolInputSummary(name: string, input: unknown): string {
  const value = object(input);
  if (name === "list_sources") return "列出当前账号可查询的数据源";
  if (name === "get_user_preferences") return "读取当前账号的查询偏好";
  if (name === "query_dataset") return bounded(queryStructure(value.query));
  if (name === "save_report_definition")
    return bounded({
      title: object(value.definition).title,
      query_count: list(object(value.definition).queries).length,
    });
  return bounded(
    fields(value, [
      "source_id",
      "object_id",
      "query",
      "limit",
      "cursor",
      "metric_id",
      "version",
      "start",
      "end",
      "dimensions",
      "skill_name",
      "relative_path",
      "tool_name",
      "report_id",
      "execution_id",
      "title",
      "key",
      "scope",
      "knowledge_id",
      "question",
    ]),
  );
}
/** 输出仅摘取目录、结构和结果范围，限制体积并避免复制实际数据行。 */
function toolOutputSummary(name: string, output: unknown): string {
  const value = object(output);
  if (value.status === "rules_required")
    return `需先核对 ${list(value.business_rules).length} 条业务规则，本次尚未执行查询。`;
  if (value.items)
    return bounded({
      returned: list(value.items).length,
      items: list(value.items)
        .slice(0, 30)
        .map((item) =>
          fields(item, ["source_id", "object_id", "name", "metric_id", "version", "knowledge_id"]),
        ),
      has_more: Boolean(value.next_cursor),
    });
  if (name === "describe_dataset")
    return bounded({
      ...fields(value.dataset, ["source_id", "object_id", "name"]),
      fields: list(object(value.dataset).columns).map((column) =>
        fields(column, ["name", "data_type"]),
      ),
      relations: list(value.approved_relations).length,
      business_rules: list(value.business_rules).length,
    });
  if (name === "query_dataset" || name === "query_metric") {
    const result = name === "query_metric" ? object(value.grouped) : value;
    return bounded({
      row_count: result.row_count,
      columns: list(result.columns).map((column) => object(column).name),
      truncated: result.truncated,
      sampled: result.sampled,
      ...fields(value, ["evidence_id", "evidence_ids"]),
    });
  }
  if (name === "read_skill_reference")
    return bounded({
      ...fields(value, ["skill_name", "relative_path"]),
      characters: typeof value.content === "string" ? value.content.length : 0,
    });
  if (name === "get_tool_schema")
    return bounded({ tool_name: value.name, description: value.description });
  if (name === "get_user_preferences") return "已读取当前账号可使用的偏好与相对时间设置";
  const summary = fields(value, [
    "status",
    "report_id",
    "execution_id",
    "metric_id",
    "knowledge_id",
    "version",
    "name",
    "title",
    "clarification_id",
  ]);
  return bounded(Object.keys(summary).length ? summary : "已完成本次调用，结果已交付分析助手");
}
export { toolInputSummary, toolOutputSummary };
