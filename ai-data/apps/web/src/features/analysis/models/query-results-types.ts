import type { QueryEvidence, QueryResult } from "@ai-data/contracts";

/** 同一证据的流式样本和已保存结果共用一个展示条目。 */
type ConversationQueryResult = {
  key: string;
  title: string;
  evidenceId?: string;
  evidence?: QueryEvidence;
  table: Pick<QueryResult, "columns" | "rows">;
  rowCount?: number;
  sampled: boolean;
  truncated: boolean;
};
export type { ConversationQueryResult };
