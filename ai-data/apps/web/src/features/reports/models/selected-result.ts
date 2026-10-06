import { saveReportInputSchema } from "@ai-data/contracts";
import type { QueryEvidence, SaveReportInput } from "@ai-data/contracts";
/** 仅引用用户选中的一个依据，快照、查询转换及当前权限由 API 复核。 */
function selectedResultReport(
  evidence: QueryEvidence,
  title: string,
  description: string,
  chart?: { type: "line" | "bar" | "pie"; x: string; y: string },
): SaveReportInput {
  return saveReportInputSchema.parse({
    analysis_run_id: evidence.analysis_run_id,
    title: title.trim(),
    description: description.trim(),
    sections: [
      {
        section_id: "main",
        title: title.trim(),
        blocks: [
          {
            block_id: "result",
            title: title.trim(),
            type: chart ? "chart" : "table",
            evidence_ids: [evidence.evidence_id],
            ...(chart ? { chart } : {}),
          },
        ],
      },
    ],
    shared_with: [],
  });
}
export { selectedResultReport };
