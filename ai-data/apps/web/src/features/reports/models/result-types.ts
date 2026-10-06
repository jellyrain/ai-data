import type { QueryEvidence, ReportDefinition } from "@ai-data/contracts";
/** 展示区块携带已匹配来源和可读的字段异常。 */
type ReportBlockView = Omit<
  ReportDefinition["presentation"][number]["blocks"][number],
  "query_ids" | "source_execution_id"
> & {
  evidence: QueryEvidence[];
  sourceExecutionId?: string;
  error: string;
};
/** 保留定义中的章节顺序。 */
type ReportSectionView = { section_id: string; title: string; blocks: ReportBlockView[] };
export type { ReportBlockView, ReportSectionView };
