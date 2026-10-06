import type { z } from "zod";
import type { AnalysisRunState, ReportNarrative } from "@ai-data/contracts";
import type { narrativeReceiptSchema } from "../api/report-schema";
import type { ReportDependencies } from "./report-workspace-types";
/** 回执只定位说明任务，最终正文从执行专属列表读取。 */
type NarrativeReceipt = z.infer<typeof narrativeReceiptSchema>;
/** 页面切换时释放当前执行的说明和订阅。 */
type NarrativeState = {
  executionId: string;
  items: ReportNarrative[];
  receipt: NarrativeReceipt | null;
  run: AnalysisRunState | null;
  loading: boolean;
  sending: boolean;
  answering: boolean;
  cancelling: boolean;
  error: string;
  connection: string;
  progress: string;
  uncertain: boolean;
};
/** 事件流通过应用认证边界打开。 */
type NarrativeDependencies = ReportDependencies & {
  stream: (path: string, cursor: number, signal: AbortSignal) => Promise<Response>;
  onDenied?: (message: string) => void;
};
export type { NarrativeReceipt, NarrativeState, NarrativeDependencies };
