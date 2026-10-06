import type { Dataset, MetricDefinition, PublishedKnowledge } from "@ai-data/contracts";

/** 目录发现保留定位和能力，完整字段由详情工具提供。 */
function datasetSummary(dataset: Dataset) {
  return {
    source_id: dataset.source_id,
    object_id: dataset.object_id,
    name: dataset.name,
    kind: dataset.kind,
    source_description: dataset.source_description?.slice(0, 400),
    query_capabilities: dataset.query_capabilities,
  };
}

/** 指标摘要保留固定时间依据，查询结构在选定版本后读取。 */
function metricSummary(metric: MetricDefinition) {
  return {
    metric_id: metric.metric_id,
    version: metric.version,
    name: metric.name,
    description: metric.description.slice(0, 400),
    date_basis: metric.date_basis,
    source_id: metric.query.source_id,
    object_id: metric.query.from.object_id,
  };
}

/** 知识索引只描述可发现的条目，正文及审批来源留在正式详情中。 */
function knowledgeSummary(knowledge: PublishedKnowledge) {
  const content = knowledge.content;
  return {
    knowledge_id: knowledge.knowledge_id,
    version: knowledge.version,
    type: content.type,
    name:
      content.type === "metric"
        ? content.definition.name
        : content.type === "business_rule"
          ? content.title
          : content.report_id,
    scope: knowledge.scope,
  };
}

/** 已授权结果先按命中数排序再分页，同分使用稳定标识，空关键词表示浏览。 */
function discoveryPage<T>(
  items: T[],
  options: { query?: string; cursor?: string; limit: number },
  id: (item: T) => string,
  text: (item: T) => string,
) {
  const terms = [
    ...new Set((options.query ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)),
  ];
  const ranked = items
    .map((item) => ({
      item,
      score: terms.filter((term) => text(item).toLocaleLowerCase().includes(term)).length,
    }))
    .filter((entry) => !terms.length || entry.score > 0)
    .sort((a, b) => b.score - a.score || id(a.item).localeCompare(id(b.item)));
  const offset = Number(options.cursor ?? 0);
  return {
    items: ranked.slice(offset, offset + options.limit).map((entry) => entry.item),
    ...(offset + options.limit < ranked.length
      ? { next_cursor: String(offset + options.limit) }
      : {}),
  };
}

export { datasetSummary, metricSummary, knowledgeSummary, discoveryPage };
