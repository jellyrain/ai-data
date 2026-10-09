import type { QueryEvidence } from "@ai-data/contracts";
import type { RunTimelineItem } from "../stores/run-timeline-types";

/** 工具名称只控制展示文案，执行与授权仍由服务端工具合同决定。 */
const toolActions: Record<string, string> = {
  list_sources: "读取数据源",
  search_catalog: "查找数据对象",
  describe_dataset: "读取字段定义",
  list_metrics: "读取指标列表",
  describe_metric: "确认指标口径",
  query_metric: "查询指标数据",
  query_dataset: "查询数据",
  get_business_schema: "读取业务结构",
  get_tool_schema: "读取工具定义",
  read_skill_reference: "读取分析方法",
  get_user_preferences: "读取查询偏好",
  save_user_preference: "保存查询偏好",
  get_published_knowledge: "读取业务知识",
  create_knowledge_candidate: "提交知识候选",
  get_report_definition: "读取报表定义",
  save_report_definition: "保存报表定义",
  get_report_execution: "读取报表结果",
  request_clarification: "请求补充条件",
};
function toolAction(name: string): string {
  return toolActions[name] ?? `调用 ${name}`;
}
function toolActivityLabel(
  tool: Extract<RunTimelineItem, { kind: "tool" }>,
  finished: boolean,
): string {
  const action = toolAction(tool.name);
  if (tool.success === true) return `已${action}`;
  if (tool.success === false) return `${action}未成功`;
  return finished ? `${action} · 结果未记录` : `正在${action}`;
}
/** 仅使用输出中的明确引用或精确调用标识关联证据，同名调用不共享结果。 */
function relatedToolEvidence(
  tool: Extract<RunTimelineItem, { kind: "tool" }>,
  items: readonly QueryEvidence[],
): QueryEvidence[] {
  let ids: unknown[] = [];
  try {
    const value: unknown = JSON.parse(tool.output ?? "");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const result = value as Record<string, unknown>;
      ids = [
        result.evidence_id,
        ...(Array.isArray(result.evidence_ids) ? result.evidence_ids : []),
      ];
    }
  } catch {
    /* 旧版本或截断摘要按明确调用标识关联。 */
  }
  return items.filter(
    (item) =>
      ids.includes(item.evidence_id) || (!!tool.callId && item.tool_call_id === tool.callId),
  );
}
export { toolAction, toolActivityLabel, relatedToolEvidence };
