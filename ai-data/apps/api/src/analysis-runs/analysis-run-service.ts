import { createHash, randomUUID } from "node:crypto";
import dayjs from "dayjs";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import {
  analysisStepSchema,
  clarificationSchema,
  clarificationAnswerSchema,
  queryEvidenceSchema,
  stableStringify,
  memoryIntentSchema,
  memoryContextSchema,
  type AnalysisRunState,
  type RunLease,
  type QueryEvidence,
  type MetricDefinition,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { assertEvidenceAccess } from "../evidence/evidence-access";
import type { RunDependencies } from "./analysis-run-types";
import type { ToolAudit } from "./tool-audit-types";
import type { HarnessCompaction } from "../harness/harness-types";
import { toolAuditSchema } from "./tool-audit";
import { runTime, runTimeMilliseconds } from "./run-time";
import {
  parseAnalysisQuery,
  assertAnalysisResultBudget,
  sampleAnalysisRows,
} from "./analysis-query";

const terminal = new Set(["completed", "failed", "cancelled"]);

/** 运行状态由持久化快照决定，进程内控制器只负责及时中断当前工作。 */
class AnalysisRunService {
  private readonly now: () => number;
  private readonly leaseMilliseconds: number;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly queries = new Map<string, Promise<QueryEvidence>>();
  constructor(private readonly dependencies: RunDependencies) {
    this.now = dependencies.now ?? (() => dayjs().valueOf());
    this.leaseMilliseconds = dependencies.leaseMilliseconds ?? 30000;
  }

  /** 设置操作与租约检查共用事务，取消或接管后不能留下迟到写入。 */
  async recordMemoryContext(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    input: unknown,
  ): Promise<void> {
    const memoryContext = memoryContextSchema.parse(input);
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      return { memoryContext };
    });
  }

  /** 设置操作与租约检查共用事务，取消或接管后不能留下迟到写入。 */
  async withLease<T>(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    operation: (executor: MetadataQueryExecutor) => Promise<T>,
  ): Promise<T> {
    let result: T;
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      return {
        apply: async (executor) => {
          result = await operation(executor);
          this.assertLease(state, lease);
        },
      };
    });
    return result!;
  }

  /** 意图归属由运行核对，失败或取消的运行不会派发后台任务。 */
  async remember(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    input: unknown,
  ): Promise<void> {
    const intent = memoryIntentSchema.parse(input);
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      const source = intent.type === "query_habit" ? intent.source : intent.candidate.source;
      if (
        !source ||
        source.analysis_run_id !== runId ||
        source.conversation_id !== state.conversation_id ||
        source.evidence_ids.some((id) => !state.evidence_ids.includes(id))
      )
        throw new ApplicationError("INVALID_INPUT", "记忆来源不属于当前运行");
      return { memoryIntents: [intent] };
    });
  }

  async get(context: AuthContext, runId: string): Promise<AnalysisRunState> {
    context = await this.dependencies.refreshContext(context);
    const state = await this.dependencies.repository.get(context, runId);
    const evidence = await this.dependencies.repository.listEvidence(context, runId);
    await Promise.all(
      evidence.map((item) => assertEvidenceAccess(item, context, this.dependencies.authorization)),
    );
    return state;
  }

  async evidence(context: AuthContext, runId: string): Promise<QueryEvidence[]> {
    const evidence = await this.dependencies.repository.listEvidence(context, runId);
    const current = await this.dependencies.refreshContext(context);
    await Promise.all(
      evidence.map((item) => assertEvidenceAccess(item, current, this.dependencies.authorization)),
    );
    return evidence;
  }

  async events(context: AuthContext, runId: string, after: number) {
    const events = await this.dependencies.repository.listEvents(context, runId, after);
    await this.get(context, runId);
    return events;
  }
  async steps(context: AuthContext, runId: string) {
    const steps = await this.dependencies.repository.listSteps(context, runId);
    await this.get(context, runId);
    return steps;
  }

  /** 单次结构化查询入口：认领运行、留存证据并提交终态。 */
  async execute(
    context: AuthContext,
    runId: string,
    key: string,
    input: unknown,
  ): Promise<QueryEvidence> {
    const query = parseAnalysisQuery(input);
    const toolCallId = "query-" + createHash("sha256").update(key).digest("hex");
    const existing = (await this.evidence(context, runId)).find(
      (item) => item.tool_call_id === toolCallId,
    );
    if (
      existing &&
      stableStringify(parseAnalysisQuery(existing.requested_query)) !== stableStringify(query)
    )
      throw new ApplicationError("CONFLICT", "查询幂等键已用于其他内容");
    if (existing && (await this.get(context, runId)).status === "completed") return existing;
    const lease = await this.claim(context, runId, randomUUID());
    try {
      const evidence = existing ?? (await this.query(context, runId, lease, toolCallId, query));
      await this.complete(context, runId, lease, "查询完成");
      return evidence;
    } catch (error) {
      await this.fail(context, runId, lease, error);
      throw error;
    }
  }

  /** created 或租约过期的 running 可以认领，成功后代次单调递增。 */
  async claim(context: AuthContext, runId: string, owner: string): Promise<RunLease> {
    await this.get(context, runId);
    const state = await this.dependencies.repository.change(context, runId, (state) => {
      if (
        !["created", "running"].includes(state.status) ||
        (state.lease && dayjs(runTimeMilliseconds(state.lease.expires_at)).isAfter(this.now()))
      )
        throw new ApplicationError("CONFLICT", "运行当前不能认领");
      state.lease_epoch++;
      state.lease = {
        owner,
        epoch: state.lease_epoch,
        expires_at: runTime(dayjs(this.now()).add(this.leaseMilliseconds, "millisecond")),
      };
      state.status = "running";
      state.updated_at = runTime(this.now());
      return { events: [{ type: "run_started" }] };
    });
    return state.lease!;
  }

  async renew(context: AuthContext, runId: string, lease: RunLease): Promise<RunLease> {
    await this.dependencies.refreshContext(context);
    const state = await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      state.lease!.expires_at = runTime(
        dayjs(this.now()).add(this.leaseMilliseconds, "millisecond"),
      );
      state.updated_at = runTime(this.now());
      return {};
    });
    return state.lease!;
  }

  async clarify(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    input: unknown,
    audit?: ToolAudit,
  ): Promise<AnalysisRunState> {
    const clarification = clarificationSchema.parse(input);
    return this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      state.status = "waiting_clarification";
      state.clarification = clarification;
      state.lease = null;
      state.updated_at = runTime(this.now());
      return {
        events: [{ type: "clarification", ...clarification }],
        messages: [
          {
            role: "assistant",
            content:
              clarification.question +
              "\n" +
              clarification.options.map((option) => option.label).join("\n"),
          },
        ],
        ...(audit ? { audits: [audit] } : {}),
      };
    });
  }

  async answer(context: AuthContext, runId: string, input: unknown): Promise<AnalysisRunState> {
    const answer = clarificationAnswerSchema.parse(input);
    await this.get(context, runId);
    return this.dependencies.repository.change(
      context,
      runId,
      (state) => {
        const question = state.clarification;
        if (
          state.status !== "waiting_clarification" ||
          question?.clarification_id !== answer.clarification_id
        )
          throw new ApplicationError("CONFLICT", "当前运行没有该待答问题");
        if (
          (answer.option_id &&
            !question.options.some((option) => option.id === answer.option_id)) ||
          (answer.custom_input && !question.allow_custom_input)
        )
          throw new ApplicationError("INVALID_INPUT", "澄清回答不属于当前问题");
        state.status = "created";
        state.clarification = null;
        state.updated_at = runTime(this.now());
        return {
          ...(question.preference_confirmation_id
            ? {
                apply: async (executor: MetadataQueryExecutor) => {
                  if (!this.dependencies.applyPreferenceAnswer)
                    throw new ApplicationError("INTERNAL_ERROR", "偏好确认服务未配置");
                  if (!["approve", "reject"].includes(answer.option_id ?? ""))
                    throw new ApplicationError("INVALID_INPUT", "个人偏好确认需要选择同意或拒绝");
                  await this.dependencies.applyPreferenceAnswer(
                    context,
                    question.preference_confirmation_id!,
                    answer.option_id === "approve",
                    answer.idempotency_key,
                    executor,
                  );
                },
              }
            : {}),
          messages: [
            {
              role: "user",
              content:
                answer.custom_input ??
                question.options.find((option) => option.id === answer.option_id)!.label,
            },
          ],
          events: [
            {
              type: "clarification_answered",
              clarification_id: answer.clarification_id,
              ...(answer.option_id
                ? { option_id: answer.option_id }
                : { custom_input: answer.custom_input }),
            },
          ],
        };
      },
      {
        key: answer.idempotency_key,
        hash: createHash("sha256").update(stableStringify(answer)).digest("hex"),
      },
    );
  }

  /** 先提交取消状态，再中断本进程任务；其他执行器续租或提交时也会被持久化状态拒绝。 */
  async cancel(context: AuthContext, runId: string): Promise<AnalysisRunState> {
    await this.dependencies.repository.change(context, runId, (state) => {
      if (terminal.has(state.status)) return {};
      state.status = "cancelling";
      return { events: [{ type: "run_state", status: "cancelling" }] };
    });
    for (const controller of this.controllers.get(runId) ?? []) controller.abort();
    return this.dependencies.repository.change(context, runId, (state) => {
      if (terminal.has(state.status)) return {};
      state.status = "cancelled";
      state.lease = null;
      state.updated_at = runTime(this.now());
      return { events: [{ type: "run_cancelled" }] };
    });
  }

  async complete(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    content: string,
    operation?: (executor: MetadataQueryExecutor) => Promise<void>,
  ): Promise<AnalysisRunState> {
    await this.get(context, runId);
    return this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      const expiresAt = state.lease!.expires_at;
      state.status = "completed";
      state.lease = null;
      state.updated_at = runTime(this.now());
      return {
        ...(operation || this.dependencies.completeOperation
          ? {
              apply: async (executor: MetadataQueryExecutor) => {
                await this.dependencies.completeOperation?.(context, runId, executor, content);
                await operation?.(executor);
                if (!dayjs(runTimeMilliseconds(expiresAt)).isAfter(this.now()))
                  throw new ApplicationError("CONFLICT", "提交时运行租约已过期");
              },
            }
          : {}),
        messages: [{ role: "assistant", content }],
        events: [{ type: "final_answer", content }, { type: "run_completed" }],
      };
    });
  }

  /** 仅当前有效执行器可以记录失败，已过期或取消的执行不覆盖当前状态。 */
  async fail(context: AuthContext, runId: string, lease: RunLease, error: unknown): Promise<void> {
    await this.dependencies.repository.change(context, runId, (state) => {
      if (
        state.status !== "running" ||
        state.lease?.owner !== lease.owner ||
        state.lease_epoch !== lease.epoch ||
        !dayjs(runTimeMilliseconds(state.lease.expires_at)).isAfter(this.now())
      )
        return {};
      state.status = "failed";
      state.lease = null;
      state.updated_at = runTime(this.now());
      state.error = {
        code: error instanceof ApplicationError ? error.code : "INTERNAL_ERROR",
        message: "分析执行失败",
      };
      return { events: [{ type: "run_failed", ...state.error }] };
    });
  }

  /** 压缩状态沿用运行事件事务和租约隔离，已结束执行不能追加进度。 */
  async recordCompaction(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    event: HarnessCompaction,
  ): Promise<void> {
    await this.get(context, runId);
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      return {
        events: [
          {
            type: "context_compaction",
            item_id: event.itemId,
            status: event.status,
            occurred_at: runTime(this.now()),
          },
        ],
      };
    });
  }

  async saveStep(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    input: unknown,
  ): Promise<void> {
    const step = analysisStepSchema.parse(input);
    await this.get(context, runId);
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      if (
        step.analysis_run_id !== runId ||
        step.evidence_ids.some((id) => !state.evidence_ids.includes(id))
      )
        throw new ApplicationError("INVALID_INPUT", "分析步骤引用的证据不属于运行");
      return { steps: [step], events: [{ type: "progress", message: step.title }] };
    });
  }

  /** 只读工具调用通过稳定标识关联证据；已完成调用先复核权限再复用结果。 */
  async query(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    toolCallId: string,
    input: unknown,
    metric?: Pick<MetricDefinition, "metric_id" | "version">,
    options?: { managed: boolean },
  ): Promise<QueryEvidence> {
    await this.assertCurrent(context, runId, lease);
    const requested = parseAnalysisQuery(input);
    const existing = (await this.evidence(context, runId)).find(
      (item) => item.tool_call_id === toolCallId,
    );
    if (existing) {
      if (
        stableStringify(parseAnalysisQuery(existing.requested_query)) !==
          stableStringify(requested) ||
        stableStringify(existing.metric ?? null) !== stableStringify(metric ?? null)
      )
        throw new ApplicationError("CONFLICT", "工具调用标识已用于其他查询");
      return existing;
    }
    const key = `${runId}:${toolCallId}`;
    if (this.queries.has(key)) throw new ApplicationError("CONFLICT", "该工具调用正在执行");
    const task = this.executeQuery(context, runId, lease, toolCallId, requested, metric, options);
    this.queries.set(key, task);
    try {
      return await task;
    } finally {
      this.queries.delete(key);
    }
  }

  private async executeQuery(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    toolCallId: string,
    input: unknown,
    metric?: Pick<MetricDefinition, "metric_id" | "version">,
    options?: { managed: boolean },
  ): Promise<QueryEvidence> {
    const requested = parseAnalysisQuery(input);
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      return {
        events: options?.managed
          ? []
          : [
              {
                type: "tool_call",
                tool_call_id: toolCallId,
                tool_name: "query_dataset",
                input_summary: requested.from.object_id,
              },
            ],
      };
    });
    const controller = new AbortController();
    const controllers = this.controllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(runId, controllers);
    let renewing = false;
    const timer = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void this.renew(context, runId, lease)
          .catch(() => controller.abort())
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(100, Math.floor(this.leaseMilliseconds / 3)),
    );
    try {
      const authorized = await this.dependencies.authorization.authorize(
        requested,
        await this.dependencies.refreshContext(context),
        runId,
      );
      const result = await this.dependencies.client.execute(authorized, {
        signal: controller.signal,
      });
      assertAnalysisResultBudget(result);
      const sampleRows = sampleAnalysisRows(result);
      const evidence = queryEvidenceSchema.parse({
        evidence_id: randomUUID(),
        tool_call_id: toolCallId,
        analysis_run_id: runId,
        organization_id: context.organizationId,
        user_id: context.userId,
        created_at: runTime(this.now()),
        requested_query: requested,
        authorized_query: authorized.request.query,
        output_masks: authorized.request.access.output_masks,
        result,
        ...(metric ? { metric } : {}),
      });
      await assertEvidenceAccess(
        evidence,
        await this.dependencies.refreshContext(context),
        this.dependencies.authorization,
      );
      await this.dependencies.repository.change(context, runId, (state) => {
        this.assertLease(state, lease);
        if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "运行已取消");
        state.evidence_ids.push(evidence.evidence_id);
        return {
          evidence: [evidence],
          events: [
            {
              type: "tool_result",
              tool_call_id: toolCallId,
              tool_name: "query_dataset",
              success: true,
              output_summary: `返回 ${result.row_count} 行`,
            },
            {
              type: "table",
              evidence_id: evidence.evidence_id,
              columns: result.columns,
              rows: sampleRows,
              result_row_count: result.row_count,
              result_truncated: result.truncated,
              sampled: sampleRows.length < result.row_count,
            },
          ],
        };
      });
      return evidence;
    } catch (error) {
      // 取消、接管或终态不接受旧执行器的失败覆盖。
      if (!options?.managed) await this.fail(context, runId, lease, error);
      throw error;
    } finally {
      clearInterval(timer);
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(runId);
    }
  }

  private assertLease(state: AnalysisRunState, lease: RunLease): void {
    if (
      state.status !== "running" ||
      state.lease?.owner !== lease.owner ||
      state.lease_epoch !== lease.epoch ||
      !dayjs(runTimeMilliseconds(state.lease.expires_at)).isAfter(this.now())
    )
      throw new ApplicationError("CONFLICT", "运行租约已失效或状态已变化");
  }

  /** 所有 Agent 工具和复用证据都要求调用方仍持有当前租约。 */
  async assertCurrent(context: AuthContext, runId: string, lease: RunLease): Promise<void> {
    await this.dependencies.refreshContext(context);
    this.assertLease(await this.dependencies.repository.get(context, runId), lease);
  }

  /** 模型和查询共用取消注册表，取消状态提交后立即中断进程内工作。 */
  attachController(runId: string, controller: AbortController): () => void {
    const controllers = this.controllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(runId, controllers);
    return () => {
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(runId);
    };
  }

  /** 模型失败或超时后中断在途查询，并等待连接回收。 */
  async interrupt(runId: string): Promise<void> {
    for (const controller of this.controllers.get(runId) ?? []) controller.abort();
    await Promise.allSettled(
      [...this.queries.entries()]
        .filter(([key]) => key.startsWith(runId + ":"))
        .map(([, query]) => query),
    );
  }

  /** 服务正常关闭时释放有效租约，下一实例可从持久化证据继续。 */
  async release(context: AuthContext, runId: string, lease: RunLease): Promise<void> {
    await this.dependencies.repository.change(context, runId, (state) => {
      if (
        state.status !== "running" ||
        state.lease?.owner !== lease.owner ||
        state.lease_epoch !== lease.epoch
      )
        return {};
      state.status = "created";
      state.lease = null;
      state.updated_at = runTime(this.now());
      return { events: [{ type: "run_state", status: "created" }] };
    });
  }

  /** 工具摘要和对外事件与租约校验在同一事务中提交。 */
  async recordTool(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    input: ToolAudit,
  ): Promise<void> {
    const audit = toolAuditSchema.parse(input);
    await this.dependencies.repository.change(context, runId, (state) => {
      this.assertLease(state, lease);
      return {
        audits: [audit],
        events: [
          audit.status === "running"
            ? {
                type: "tool_call",
                tool_call_id: audit.tool_call_id,
                tool_name: audit.tool_name,
                input_summary: "执行已校验的业务条件",
              }
            : {
                type: "tool_result",
                tool_call_id: audit.tool_call_id,
                tool_name: audit.tool_name,
                success: audit.status === "completed",
                output_summary: audit.error_code ?? "工具执行完成",
              },
        ],
      };
    });
  }
}

export { AnalysisRunService };
