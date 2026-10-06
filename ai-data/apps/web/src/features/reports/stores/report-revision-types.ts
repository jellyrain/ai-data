import type { AnalysisRunState, SseEvent } from "@ai-data/contracts";
import type { NarrativeDependencies, NarrativeReceipt } from "./report-narrative-types";
/** 修改回执的版本绑定来自本次成功提交请求，持久恢复须由服务端再次核对。 */
type RevisionState = {
  reportId: string;
  version: number;
  receipt: NarrativeReceipt | null;
  run: AnalysisRunState | null;
  sending: boolean;
  restoring: boolean;
  restoreRunId: string;
  answering: boolean;
  cancelling: boolean;
  uncertain: boolean;
  error: string;
  progress: string;
  events: SseEvent[];
  connection: string;
  committed: boolean;
};
/** 编辑器负责锁定草稿，并在事务成功后读取准确的新版本。 */
type RevisionDependencies = NarrativeDependencies & {
  lock: (value: boolean) => void;
  commit: (version: number) => Promise<void>;
};
export type { RevisionState, RevisionDependencies };
