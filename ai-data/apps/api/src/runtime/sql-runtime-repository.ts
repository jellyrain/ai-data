import { z } from "zod";
import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { analysisRunSchema, stableStringify, type RunLease } from "@ai-data/contracts";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { SqlAnalysisRunRepository } from "../analysis-runs/sql-analysis-run-repository";
import { runTime, runTimeMilliseconds } from "../analysis-runs/run-time";
import { toolAuditSchema } from "../analysis-runs/tool-audit";
import type { AnalysisInput, PendingAnalysis, RuntimeRepository } from "./runtime-types";

/** 待执行记录只保存受信任的身份引用，恢复不依赖进程内的权限快照。 */
const pendingSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    organization_id: z.string(),
    session_id: z.string(),
  })
  .strict();
const messageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    analysis_run_id: z.string().nullable(),
  })
  .strict();

class SqlRuntimeRepository implements RuntimeRepository {
  private readonly runs: SqlAnalysisRunRepository;
  constructor(private readonly database: MetadataTransactionalExecutor) {
    this.runs = new SqlAnalysisRunRepository(database);
  }
  async pending(limit: number): Promise<PendingAnalysis[]> {
    const result = await this.database.execute({
      sql: `SELECT TOP (@limit) r.id,r.user_id,r.organization_id,d.session_id
        FROM dbo.analysis_dispatches d JOIN dbo.analysis_runs r ON r.id=d.analysis_run_id
        JOIN dbo.analysis_run_states s ON s.analysis_run_id=r.id
        WHERE r.status='created' OR (r.status='running' AND JSON_VALUE(s.state_json,'$.lease.expires_at')<=@now)
        ORDER BY r.created_at,r.id`,
      parameters: [
        { name: "limit", type: "integer", value: Math.max(1, Math.min(limit, 100)) },
        { name: "now", type: "string", value: runTime() },
      ],
    });
    return result.rows.map((value) => {
      const row = pendingSchema.parse(value);
      return {
        runId: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        sessionId: row.session_id,
      };
    });
  }
  async loadInput(context: AuthContext, runId: string, runtimeKey = ""): Promise<AnalysisInput> {
    const state = await this.runs.get(context, runId);
    const result = await this.database.execute({
      sql: "SELECT TOP (200) role,content,analysis_run_id FROM dbo.conversation_messages WHERE conversation_id=@conversation ORDER BY sequence DESC",
      parameters: [{ name: "conversation", type: "string", value: state.conversation_id }],
    });
    const rows = result.rows.map((row) => messageSchema.parse(row)).reverse();
    if (!rows.length) throw new ApplicationError("INVALID_INPUT", "分析运行缺少用户消息");
    const policies = await this.database.execute({
      sql: "SELECT source_id, MAX(version) AS version FROM dbo.catalog_policy_versions WHERE organization_id=@org GROUP BY source_id ORDER BY source_id",
      parameters: [{ name: "org", type: "string", value: context.organizationId }],
    });
    const contextHash = createHash("sha256")
      .update(stableStringify({ context, policies: policies.rows, runtimeKey }))
      .digest("hex");
    const saved = await this.database.execute({
      sql: "SELECT thread_id FROM dbo.analysis_codex_threads WHERE conversation_id=@conversation AND context_hash=@hash",
      parameters: [
        { name: "conversation", type: "string", value: state.conversation_id },
        { name: "hash", type: "string", value: contextHash },
      ],
    });
    const history = await this.database.execute({
      sql: "SELECT id FROM dbo.analysis_runs WHERE conversation_id=@conversation ORDER BY created_at,id",
      parameters: [{ name: "conversation", type: "string", value: state.conversation_id }],
    });
    return {
      conversation_id: state.conversation_id,
      context_hash: contextHash,
      ...(saved.rows[0] ? { thread_id: z.string().min(1).parse(saved.rows[0].thread_id) } : {}),
      messages: rows.map(({ role, content }) => ({ role, content })),
      run_ids: history.rows.map((row) => z.string().parse(row.id)),
    };
  }
  /** 以会话、运行的统一锁顺序校验租约，防止过期执行器覆盖恢复入口。 */
  async saveThread(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    contextHash: string,
    threadId: string,
  ): Promise<void> {
    z.string().min(1).max(128).parse(threadId);
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(contextHash);
    await this.database.transaction(async (executor) => {
      const parameters = [
        { name: "id", type: "string" as const, value: runId },
        { name: "user", type: "string" as const, value: context.userId },
        { name: "org", type: "string" as const, value: context.organizationId },
      ];
      await executor.execute({
        sql: "SELECT c.id FROM dbo.conversations c WITH (UPDLOCK,HOLDLOCK) JOIN dbo.analysis_runs r ON r.conversation_id=c.id WHERE r.id=@id AND r.user_id=@user AND r.organization_id=@org",
        parameters,
      });
      const current = await executor.execute({
        sql: "SELECT s.state_json FROM dbo.analysis_run_states s WITH (UPDLOCK,HOLDLOCK) JOIN dbo.analysis_runs r ON r.id=s.analysis_run_id WHERE r.id=@id AND r.user_id=@user AND r.organization_id=@org",
        parameters,
      });
      if (!current.rows[0]) throw new ApplicationError("NOT_FOUND", "分析运行不存在");
      const state = analysisRunSchema.parse(
        JSON.parse(z.string().parse(current.rows[0].state_json)),
      );
      if (
        state.status !== "running" ||
        state.lease?.owner !== lease.owner ||
        state.lease_epoch !== lease.epoch ||
        !dayjs(runTimeMilliseconds(state.lease.expires_at)).isAfter(dayjs())
      )
        throw new ApplicationError("CONFLICT", "分析执行租约已失效");
      await executor.execute({
        sql: "UPDATE dbo.analysis_codex_threads SET thread_id=@thread,context_hash=@hash,updated_at=SYSUTCDATETIME() WHERE conversation_id=@conversation; IF @@ROWCOUNT=0 INSERT INTO dbo.analysis_codex_threads(conversation_id,thread_id,context_hash) VALUES(@conversation,@thread,@hash);",
        parameters: [
          { name: "conversation", type: "string", value: state.conversation_id },
          { name: "thread", type: "string", value: threadId },
          { name: "hash", type: "string", value: contextHash },
        ],
      });
    });
  }
  async rejectPending(task: PendingAnalysis, code: string): Promise<void> {
    await this.runs.change(
      { ...task, roles: [], permissions: [], dataPolicies: [] },
      task.runId,
      (state) => {
        if (
          state.status !== "created" &&
          !(
            state.status === "running" &&
            state.lease &&
            !dayjs(runTimeMilliseconds(state.lease.expires_at)).isAfter(dayjs())
          )
        )
          return {};
        state.status = "failed";
        state.lease = null;
        state.updated_at = runTime();
        state.error = { code, message: "登录会话已失效，请重新发起分析" };
        return { events: [{ type: "run_failed", ...state.error }] };
      },
    );
  }
  async listAudits(context: AuthContext, runId: string) {
    await this.runs.get(context, runId);
    const result = await this.database.execute({
      sql: "SELECT audit_json FROM dbo.analysis_tool_audits WHERE analysis_run_id=@id ORDER BY updated_at,tool_call_id",
      parameters: [{ name: "id", type: "string", value: runId }],
    });
    return result.rows.map((row) =>
      toolAuditSchema.parse(JSON.parse(z.string().parse(row.audit_json)) as unknown),
    );
  }
}
export { SqlRuntimeRepository };
