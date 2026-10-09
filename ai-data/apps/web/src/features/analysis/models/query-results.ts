import type { QueryEvidence, SseEvent } from "@ai-data/contracts";
import type { ConversationQueryResult } from "./query-results-types";

/** 以首次出现顺序合并结果；完整证据覆盖样本，避免回放和读取依据造成重复表格。 */
function projectQueryResults(
  events: readonly SseEvent[],
  evidence: readonly QueryEvidence[],
): ConversationQueryResult[] {
  const items = new Map<string, ConversationQueryResult>();
  const saved = new Map(evidence.map((item) => [item.evidence_id, item]));
  for (const event of events) {
    if (event.type !== "table") continue;
    const key = event.evidence_id ?? `event:${event.lease_epoch ?? 0}:${event.sequence}`;
    const item = event.evidence_id ? saved.get(event.evidence_id) : undefined;
    items.set(key, {
      key,
      title: "",
      evidenceId: event.evidence_id,
      evidence: item,
      table: item?.result ?? event,
      rowCount: item?.result.row_count ?? event.result_row_count,
      sampled: !item && !!event.sampled,
      truncated: item?.result.truncated ?? !!event.result_truncated,
    });
  }
  for (const item of evidence) {
    if (items.has(item.evidence_id)) continue;
    items.set(item.evidence_id, {
      key: item.evidence_id,
      title: "",
      evidenceId: item.evidence_id,
      evidence: item,
      table: item.result,
      rowCount: item.result.row_count,
      sampled: false,
      truncated: item.result.truncated,
    });
  }
  return [...items.values()].map((item, index) => ({ ...item, title: `查询 ${index + 1}` }));
}
export { projectQueryResults };
