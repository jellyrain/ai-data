import type {
  AnalysisRunState,
  AnalysisStep,
  QueryEvidence,
  SseEvent,
  MemoryIntent,
  MemoryContext,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type { ApiQueryAuthorization, ApiQueryClient } from "../app-types";
import type { ToolAudit } from "./tool-audit-types";

/** 执行前后从可信身份来源重新读取权限。 */
type RunDependencies = {
  repository: AnalysisRunRepository;
  authorization: ApiQueryAuthorization;
  client: ApiQueryClient;
  refreshContext: (context: AuthContext) => Promise<AuthContext>;
  now?: () => number;
  leaseMilliseconds?: number;
  /** 对话修改在成功终态事务内提交，取消或失败不触发。 */
  completeOperation?: (
    context: AuthContext,
    runId: string,
    executor: MetadataQueryExecutor,
    content: string,
  ) => Promise<void>;
  applyPreferenceAnswer?: (
    context: AuthContext,
    confirmationId: string,
    approved: boolean,
    key: string,
    executor: MetadataQueryExecutor,
  ) => Promise<void>;
};

/** 事件的归属、序号和代次由事务仓储统一补齐。 */
type RunEvent = SseEvent extends infer Event
  ? Event extends SseEvent
    ? Omit<Event, "conversation_id" | "analysis_run_id" | "sequence" | "lease_epoch">
    : never
  : never;
type RunChange = {
  memoryContext?: MemoryContext;
  memoryIntents?: MemoryIntent[];
  apply?: (executor: MetadataQueryExecutor) => Promise<void>;
  events?: RunEvent[];
  evidence?: QueryEvidence[];
  steps?: AnalysisStep[];
  messages?: { role: "assistant" | "user"; content: string }[];
  audits?: ToolAudit[];
};
type RunReceipt = { key: string; hash: string };
/** 运行变更持有行锁，状态、事件、证据和操作幂等记录一起提交。 */
interface AnalysisRunRepository {
  get(context: AuthContext, runId: string): Promise<AnalysisRunState>;
  change(
    context: AuthContext,
    runId: string,
    operation: (state: AnalysisRunState) => RunChange,
    receipt?: RunReceipt,
  ): Promise<AnalysisRunState>;
  listEvents(context: AuthContext, runId: string, after: number): Promise<SseEvent[]>;
  listEvidence(context: AuthContext, runId: string): Promise<QueryEvidence[]>;
  listSteps(context: AuthContext, runId: string): Promise<AnalysisStep[]>;
}

export type { RunEvent, RunChange, RunReceipt, AnalysisRunRepository, RunDependencies };
