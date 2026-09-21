import { z } from "zod";
import {
  analysisRunSchema,
  queryEvidenceSchema,
  sseEventSchema,
  analysisStepSchema,
  type AnalysisRunState,
  type QueryEvidence,
  type SseEvent,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type { AnalysisRunRepository, RunChange, RunReceipt } from "./analysis-run-types";
import { persistRunMessages } from "./persist-run-messages";
import { toolAuditSchema } from "./tool-audit";
import { persistMemoryIntents, enqueueMemoryIntents } from "../memory/persist-memory-intents";

/** 持久化 JSON 在仓储边界校验，损坏记录按内部故障处理。 */
function parseRecord<T>(value: unknown, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(z.string().parse(value)) as unknown);
  } catch (cause) {
    throw new ApplicationError("INTERNAL_ERROR", "分析运行持久化记录无效", { cause });
  }
}
const parameters = (context: AuthContext, runId: string) => [
  { name: "id", type: "string" as const, value: runId },
  { name: "user", type: "string" as const, value: context.userId },
  { name: "org", type: "string" as const, value: context.organizationId },
];

class SqlAnalysisRunRepository implements AnalysisRunRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  private async read(
    executor: MetadataQueryExecutor,
    context: AuthContext,
    runId: string,
    lock = false,
  ): Promise<AnalysisRunState> {
    const result = await executor.execute({
      sql: `SELECT s.state_json,r.agent_id,r.agent_version FROM dbo.analysis_run_states s ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""}
        JOIN dbo.analysis_runs r ON r.id = s.analysis_run_id
        WHERE r.id = @id AND r.user_id = @user AND r.organization_id = @org`,
      parameters: parameters(context, runId),
    });
    if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", "分析运行不存在");
    const row = result.rows[0];
    const state = parseRecord(row.state_json, analysisRunSchema);
    // 运行关联列是追溯来源，旧 JSON 快照在下一次状态提交时自然补齐。
    return parseRecord(
      JSON.stringify({
        ...state,
        ...(row.agent_id == null
          ? {}
          : { agent_id: row.agent_id, agent_version: row.agent_version }),
      }),
      analysisRunSchema,
    );
  }
  get(context: AuthContext, runId: string): Promise<AnalysisRunState> {
    return this.read(this.database, context, runId);
  }

  async change(
    context: AuthContext,
    runId: string,
    operation: (state: AnalysisRunState) => RunChange,
    receipt?: RunReceipt,
  ): Promise<AnalysisRunState> {
    return this.database.transaction(async (executor) => {
      // 消息提交和运行变更使用相同锁顺序：先会话，再运行快照。
      await executor.execute({
        sql: "SELECT c.id FROM dbo.conversations c WITH (UPDLOCK,HOLDLOCK) JOIN dbo.analysis_runs r ON r.conversation_id=c.id WHERE r.id=@id AND r.user_id=@user AND r.organization_id=@org",
        parameters: parameters(context, runId),
      });
      const state = await this.read(executor, context, runId, true);
      if (receipt) {
        const existing = await executor.execute({
          sql: "SELECT request_hash FROM dbo.analysis_run_operations WHERE analysis_run_id = @id AND idempotency_key = @key",
          parameters: [
            { name: "id", type: "string", value: runId },
            { name: "key", type: "string", value: receipt.key },
          ],
        });
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== receipt.hash)
            throw new ApplicationError("CONFLICT", "幂等键已用于其他内容");
          return state;
        }
      }
      const previousStatus = state.status;
      const change = operation(state);
      if (change.memoryContext)
        await executor.execute({
          sql: "INSERT dbo.analysis_memory_contexts(analysis_run_id,lease_epoch,context_json) VALUES(@id,@epoch,@json)",
          parameters: [
            { name: "id", type: "string", value: runId },
            { name: "epoch", type: "integer", value: state.lease_epoch },
            { name: "json", type: "string", value: JSON.stringify(change.memoryContext) },
          ],
        });
      await change.apply?.(executor);
      await persistMemoryIntents(executor, runId, change.memoryIntents ?? []);
      if (previousStatus !== "completed" && state.status === "completed")
        await enqueueMemoryIntents(executor, context, runId);
      await persistRunMessages(executor, state, change.messages);
      for (const input of change.audits ?? []) {
        const audit = toolAuditSchema.parse(input);
        await executor.execute({
          sql: `UPDATE dbo.analysis_tool_audits SET audit_json=@json,updated_at=SYSUTCDATETIME()
            WHERE analysis_run_id=@id AND tool_call_id=@tool;
            IF @@ROWCOUNT=0 INSERT INTO dbo.analysis_tool_audits(analysis_run_id,tool_call_id,lease_epoch,audit_json) VALUES(@id,@tool,@epoch,@json);`,
          parameters: [
            { name: "id", type: "string", value: runId },
            { name: "tool", type: "string", value: audit.tool_call_id },
            { name: "epoch", type: "integer", value: state.lease_epoch },
            { name: "json", type: "string", value: JSON.stringify(audit) },
          ],
        });
      }
      for (const event of change.events ?? []) {
        const value = sseEventSchema.parse({
          ...event,
          conversation_id: state.conversation_id,
          analysis_run_id: runId,
          sequence: ++state.sequence,
          lease_epoch: state.lease_epoch,
        });
        await executor.execute({
          sql: "INSERT INTO dbo.analysis_run_events (analysis_run_id, sequence, event_json) VALUES (@id, @sequence, @json)",
          parameters: [
            { name: "id", type: "string", value: runId },
            { name: "sequence", type: "integer", value: value.sequence },
            { name: "json", type: "string", value: JSON.stringify(value) },
          ],
        });
      }
      for (const item of change.evidence ?? []) {
        const value = queryEvidenceSchema.parse(item);
        if (
          value.analysis_run_id !== runId ||
          value.organization_id !== context.organizationId ||
          value.user_id !== context.userId
        )
          throw new ApplicationError("INVALID_INPUT", "证据归属不匹配");
        await executor.execute({
          sql: "INSERT INTO dbo.analysis_evidence (evidence_id, analysis_run_id, tool_call_id, evidence_json) VALUES (@evidence, @id, @tool, @json)",
          parameters: [
            { name: "evidence", type: "string", value: value.evidence_id },
            { name: "id", type: "string", value: runId },
            { name: "tool", type: "string", value: value.tool_call_id },
            { name: "json", type: "string", value: JSON.stringify(value) },
          ],
        });
      }
      for (const item of change.steps ?? []) {
        const value = analysisStepSchema.parse(item);
        await executor.execute({
          sql: "UPDATE dbo.analysis_steps SET step_json = @json WHERE analysis_run_id = @id AND step_id = @step; IF @@ROWCOUNT = 0 INSERT INTO dbo.analysis_steps (analysis_run_id, step_id, step_json) VALUES (@id, @step, @json);",
          parameters: [
            { name: "id", type: "string", value: runId },
            { name: "step", type: "string", value: value.step_id },
            { name: "json", type: "string", value: JSON.stringify(value) },
          ],
        });
      }
      const validated = analysisRunSchema.parse(state);
      await executor.execute({
        sql: `UPDATE dbo.analysis_run_states SET state_json = @json WHERE analysis_run_id = @id;
        UPDATE dbo.analysis_runs SET status = @status, started_at = CASE WHEN @status = 'running' THEN COALESCE(started_at, SYSUTCDATETIME()) ELSE started_at END,
        completed_at = CASE WHEN @status IN ('completed','failed','cancelled') THEN COALESCE(completed_at, SYSUTCDATETIME()) ELSE completed_at END,
        error_code = @error_code, error_message = @error_message WHERE id = @id;`,
        parameters: [
          { name: "id", type: "string", value: runId },
          { name: "json", type: "string", value: JSON.stringify(validated) },
          { name: "status", type: "string", value: state.status },
          { name: "error_code", type: "string", value: state.error?.code ?? null },
          { name: "error_message", type: "string", value: state.error?.message ?? null },
        ],
      });
      if (receipt)
        await executor.execute({
          sql: "INSERT INTO dbo.analysis_run_operations (analysis_run_id, idempotency_key, request_hash) VALUES (@id,@key,@hash)",
          parameters: [
            { name: "id", type: "string", value: runId },
            { name: "key", type: "string", value: receipt.key },
            { name: "hash", type: "string", value: receipt.hash },
          ],
        });
      return validated;
    });
  }

  async listEvents(context: AuthContext, runId: string, after: number): Promise<SseEvent[]> {
    await this.get(context, runId);
    const result = await this.database.execute({
      sql: "SELECT TOP (200) event_json FROM dbo.analysis_run_events WHERE analysis_run_id = @id AND sequence > @after ORDER BY sequence",
      parameters: [
        { name: "id", type: "string", value: runId },
        { name: "after", type: "integer", value: after },
      ],
    });
    return result.rows.map((row) => parseRecord(row.event_json, sseEventSchema));
  }
  async listEvidence(context: AuthContext, runId: string): Promise<QueryEvidence[]> {
    await this.get(context, runId);
    const result = await this.database.execute({
      sql: "SELECT evidence_json FROM dbo.analysis_evidence WHERE analysis_run_id = @id ORDER BY evidence_id",
      parameters: [{ name: "id", type: "string", value: runId }],
    });
    return result.rows.map((row) => parseRecord(row.evidence_json, queryEvidenceSchema));
  }
  async listSteps(context: AuthContext, runId: string) {
    await this.get(context, runId);
    const result = await this.database.execute({
      sql: "SELECT step_json FROM dbo.analysis_steps WHERE analysis_run_id=@id ORDER BY step_id",
      parameters: [{ name: "id", type: "string", value: runId }],
    });
    return result.rows.map((row) => parseRecord(row.step_json, analysisStepSchema));
  }
}
export { SqlAnalysisRunRepository };
