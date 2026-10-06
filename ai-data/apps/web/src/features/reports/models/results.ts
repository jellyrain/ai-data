import type { QueryEvidence, ReportExecution, SavedReport } from "@ai-data/contracts";
import type { ReportSectionView } from "./result-types";
/** 每份执行的唯一来源只计一次，多个区块复用同一结果。 */
function checkResultBudget(sources: QueryEvidence[]): void {
  if (sources.reduce((total, source) => total + source.result.rows.length, 0) > 5000)
    throw new Error("当前结果超过 5,000 行展示预算，请缩小查询范围");
  if (
    new TextEncoder().encode(JSON.stringify(sources.map((source) => source.result))).byteLength >
    2 * 1024 * 1024
  )
    throw new Error("当前结果超过 2 MiB 展示预算，请缩小查询范围");
}
/** 执行按查询标识映射，旧快照按证据标识映射，数组次序不参与关联。 */
function reportSections(
  snapshot: SavedReport,
  execution: ReportExecution | null,
): ReportSectionView[] {
  const record =
    execution?.status === "completed" && execution.execution_id === snapshot.execution_id
      ? execution
      : null;
  const sources = record ? record.results.map((result) => result.evidence) : snapshot.sources;
  checkResultBudget(sources);
  const sections = record ? record.definition.presentation : snapshot.sections;
  return sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => {
      const evidence =
        "query_ids" in block
          ? block.query_ids.flatMap(
              (id) =>
                record?.results
                  .filter((result) => result.query_id === id)
                  .map((result) => result.evidence) ?? [],
            )
          : block.evidence_ids.flatMap((id) =>
              sources.filter((source) => source.evidence_id === id),
            );
      const fields = [
        ...(block.columns ?? []),
        ...(block.chart ? [block.chart.x, block.chart.y] : []),
      ];
      const missing = fields.filter((field) =>
        evidence.some((source) => !source.result.columns.some((column) => column.name === field)),
      );
      return {
        ...block,
        evidence,
        sourceExecutionId: "source_execution_id" in block ? block.source_execution_id : undefined,
        error: !evidence.length
          ? "找不到此区块的来源结果"
          : missing.length
            ? `结果缺少字段：${[...new Set(missing)].join("、")}`
            : "",
      };
    }),
  }));
}
export { reportSections, checkResultBudget };
