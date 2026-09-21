import type { z } from "zod";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { ReportDefinition, ReportNarrative } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { ReportDefinitionService } from "./report-definition-service";
import type { ReportExecutionService } from "./report-execution-service";
import type { reportEditContextSchema } from "./report-revision-records";
/** 对话运行的固定编辑或说明目标。 */
type ReportEditContext = z.infer<typeof reportEditContextSchema>;
/** 与分析运行同时落盘的编辑会话定位。 */
type ReportRevisionReceipt = { conversation_id: string; analysis_run_id: string };
/** 草稿只能由有效运行租约写入，成功终态时使用同一事务提交定义。 */
interface ReportRevisionRepository {
  create(
    context: AuthContext,
    target: ReportEditContext,
    prompt: string,
    key: string,
    hash: string,
    agent: { agentId: string; agentVersion: number },
  ): Promise<ReportRevisionReceipt>;
  get(
    context: AuthContext,
    runId: string,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportEditContext | null>;
  initialize(
    context: AuthContext,
    runId: string,
    target: ReportEditContext,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
  stage(
    context: AuthContext,
    runId: string,
    definition: ReportDefinition,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
  staged(
    context: AuthContext,
    runId: string,
    executor: MetadataQueryExecutor,
  ): Promise<ReportDefinition | null>;
  saveNarrative(
    context: AuthContext,
    narrative: ReportNarrative,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
  narratives(context: AuthContext, executionId: string): Promise<ReportNarrative[]>;
}
/** 共享定义服务提供唯一写入路径，运行服务负责租约及成功终态。 */
type ReportRevisionDependencies = {
  repository: ReportRevisionRepository;
  definitions: Pick<ReportDefinitionService, "get" | "save">;
  executions: Pick<ReportExecutionService, "get">;
  validate(
    context: AuthContext,
    definition: ReportDefinition,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  runs: Pick<AnalysisRunService, "withLease">;
  selectAgent?(
    context: AuthContext,
    id?: string,
  ): Promise<{ agentId: string; agentVersion: number }>;
  wake?(): void;
};
export type {
  ReportEditContext,
  ReportRevisionReceipt,
  ReportRevisionRepository,
  ReportRevisionDependencies,
};
