import { z } from "zod";
import { analysisRunSchema, analysisRunStatusSchema } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AnalysisRun } from "./analysis-run-record-types";
import { runTime } from "./run-time";

const runRowSchema = z
  .object({
    id: z.string(),
    conversation_id: z.string(),
    organization_id: z.string(),
    user_id: z.string(),
    status: analysisRunStatusSchema,
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    started_at: z.date().nullable(),
    completed_at: z.date().nullable(),
    created_at: z.date(),
  })
  .strict();
/** 在消息提交事务内创建基础记录及可恢复初始快照。 */
async function insertAnalysisRun(executor: MetadataQueryExecutor, run: AnalysisRun): Promise<void> {
  const state = analysisRunSchema.parse({
    analysis_run_id: run.id,
    conversation_id: run.conversationId,
    organization_id: run.organizationId,
    user_id: run.userId,
    status: "created",
    created_at: runTime(run.createdAt),
    updated_at: runTime(run.createdAt),
    lease_epoch: 0,
    lease: null,
    sequence: 0,
    clarification: null,
    evidence_ids: [],
    error: null,
  });
  await executor.execute({
    sql: "INSERT INTO dbo.analysis_runs (id, conversation_id, organization_id, user_id, status, created_at) VALUES (@id,@conversation,@org,@user,'created',@created); INSERT INTO dbo.analysis_run_states (analysis_run_id,state_json) VALUES (@id,@json);",
    parameters: [
      { name: "id", type: "string", value: run.id },
      { name: "conversation", type: "string", value: run.conversationId },
      { name: "org", type: "string", value: run.organizationId },
      { name: "user", type: "string", value: run.userId },
      { name: "created", type: "date", value: run.createdAt },
      { name: "json", type: "string", value: JSON.stringify(state) },
    ],
  });
}
/** 幂等提交返回已存在的运行标识及当前基础状态。 */
async function readAnalysisRun(executor: MetadataQueryExecutor, id: string): Promise<AnalysisRun> {
  const result = await executor.execute({
    sql: "SELECT id, conversation_id, organization_id, user_id, status, error_code, error_message, started_at, completed_at, created_at FROM dbo.analysis_runs WHERE id = @id",
    parameters: [{ name: "id", type: "string", value: id }],
  });
  const row = runRowSchema.parse(result.rows[0]);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}
export { insertAnalysisRun, readAnalysisRun };
