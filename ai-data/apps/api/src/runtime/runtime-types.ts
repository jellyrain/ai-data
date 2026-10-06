import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisHarness, HarnessConfiguration } from "../harness/harness-types";
import type { AnalysisTools } from "./analysis-tools";
import type { RunLease } from "@ai-data/contracts";

/** 派发只保存会话身份引用，执行时重新从认证库加载有效授权。 */
type PendingAnalysis = { runId: string; userId: string; organizationId: string; sessionId: string };
/** 已校验归属的会话上下文。运行引用用于在历史内容进入模型前重新授权。 */
type AnalysisInput = {
  conversation_id: string;
  context_hash: string;
  thread_id?: string;
  messages: { role: string; content: string }[];
  run_ids: string[];
};
/** 恢复扫描与上下文读取复用 SQL 元数据库。 */
interface RuntimeRepository {
  pending(limit: number): Promise<PendingAnalysis[]>;
  loadInput(context: AuthContext, runId: string, runtimeKey?: string): Promise<AnalysisInput>;
  saveThread(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    contextHash: string,
    threadId: string,
  ): Promise<void>;
  rejectPending(task: PendingAnalysis, code: string): Promise<void>;
}
/** 执行器依赖现有业务服务，终态由执行器在多次工具调用结束后提交。 */
type ExecutorDependencies = {
  runs: AnalysisRunService;
  harness: AnalysisHarness;
  tools: AnalysisTools;
  repository: Pick<RuntimeRepository, "loadInput" | "saveThread">;
  refreshContext: (context: AuthContext) => Promise<AuthContext>;
  instructions: string;
  runtimeKey?: string;
  loadMemory?: (context: AuthContext) => Promise<unknown>;
  /** 所有当前可见知识的版本元信息，只用于恢复授权复核，不作为模型正文。 */
  loadMemoryFingerprint?: (context: AuthContext) => Promise<unknown>;
  loadReportContext?: (context: AuthContext, runId: string) => Promise<unknown>;
  heartbeatMs?: number;
  maxToolCalls?: number;
  maxContextBytes?: number;
  resolveConfiguration?: (
    context: AuthContext,
    runId: string,
  ) => Promise<ResolvedRuntimeConfiguration>;
};
/** 从会话绑定版本装配出的单轮运行能力和预算。 */
type ResolvedRuntimeConfiguration = {
  tools: AnalysisTools;
  instructions: string;
  runtimeKey: string;
  configuration: HarnessConfiguration;
  maxToolCalls: number;
  maxContextBytes: number;
};
/** 服务生命周期内的后台扫描能力。 */
interface AnalysisDispatcher {
  wake(): void;
  start(): void;
  close(): Promise<void>;
}
export type {
  PendingAnalysis,
  AnalysisInput,
  RuntimeRepository,
  ExecutorDependencies,
  ResolvedRuntimeConfiguration,
  AnalysisDispatcher,
};
