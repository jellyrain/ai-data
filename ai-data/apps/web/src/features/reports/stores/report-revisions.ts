import { shallowReactive } from "vue";
import {
  analysisRunSchema,
  clarificationAnswerSchema,
  reportRevisionBindingSchema,
} from "@ai-data/contracts";
import type { AnalysisRunState, SseEvent } from "@ai-data/contracts";
import { createUuid } from "../../../shared/identity/create-uuid";
import { ApiError } from "../../../shared/http/api-error";
import { subscribeRun, isTerminal } from "../../../shared/stream/run-stream";
import { narrativeReceiptSchema } from "../api/report-schema";
import { reportError } from "./report-workspace";
import type { RevisionState, RevisionDependencies } from "./report-revision-types";
function initialState(): RevisionState {
  return {
    reportId: "",
    version: 0,
    receipt: null,
    run: null,
    sending: false,
    restoring: false,
    restoreRunId: "",
    answering: false,
    cancelling: false,
    uncertain: false,
    error: "",
    progress: "",
    events: [],
    connection: "",
    committed: false,
  };
}
/** AI只在运行成功事务中保存新版本，过程事件不替换编辑草稿。 */
class ReportRevisions {
  readonly state = shallowReactive<RevisionState>(initialState());
  private controller = new AbortController();
  private subscription?: AbortController;
  private generation = 0;
  private cursor = 0;
  private pending?: {
    expected_version: number;
    prompt: string;
    agent_id?: string;
    idempotency_key: string;
  };
  private answerKey?: { signature: string; key: string };
  private unregister: () => void;
  constructor(private readonly dependencies: RevisionDependencies) {
    this.unregister = dependencies.resources.register(() => this.leave());
  }
  private current(generation: number) {
    return generation === this.generation && !this.controller.signal.aborted;
  }
  get active(): boolean {
    return (
      this.state.sending ||
      this.state.restoring ||
      (!!this.state.restoreRunId && !this.state.receipt) ||
      this.state.uncertain ||
      (!!this.state.receipt &&
        (!this.state.run ||
          !isTerminal(this.state.run.status) ||
          (this.state.run.status === "completed" && !this.state.committed)))
    );
  }
  leave(): void {
    this.controller.abort();
    this.subscription?.abort();
    this.generation++;
    this.cursor = 0;
    this.pending = undefined;
    this.answerKey = undefined;
    Object.assign(this.state, initialState());
    this.dependencies.lock(false);
  }
  dispose(): void {
    this.leave();
    this.unregister();
  }
  select(id: string): void {
    this.leave();
    this.controller = new AbortController();
    this.state.reportId = id;
  }
  private failed(error: unknown): void {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      this.leave();
      this.dependencies.onDenied?.(reportError(error));
    }
    this.state.error = reportError(error);
  }
  /** 整页恢复先验证绑定，再读取运行；恢复路径始终只发起 GET。 */
  async restore(runId: string): Promise<void> {
    if (
      !this.state.reportId ||
      !runId ||
      (this.state.restoring && this.state.restoreRunId === runId)
    )
      return;
    const reportId = this.state.reportId;
    this.select(reportId);
    this.state.restoreRunId = runId;
    this.state.restoring = true;
    this.dependencies.lock(true);
    const generation = this.generation;
    try {
      const binding = reportRevisionBindingSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(reportId)}/revisions/${encodeURIComponent(runId)}`,
          { signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return;
      if (binding.report_id !== reportId || binding.analysis_run_id !== runId)
        throw new ApiError("报表修改任务绑定不一致", 403);
      const run = analysisRunSchema.parse(
        await this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(runId)}`, {
          signal: this.controller.signal,
        }),
      );
      if (!this.current(generation)) return;
      const identity = this.dependencies.identity();
      if (
        !identity ||
        run.user_id !== identity.userId ||
        run.organization_id !== identity.organizationId ||
        run.analysis_run_id !== runId
      )
        throw new ApiError("修改任务归属不一致", 403);
      this.state.version = binding.expected_version;
      this.state.receipt = { analysis_run_id: runId, conversation_id: run.conversation_id };
      this.state.run = run;
      this.connect();
    } catch (error) {
      if (this.current(generation)) this.failed(error);
    } finally {
      if (this.current(generation)) this.state.restoring = false;
    }
  }
  async start(version: number, prompt: string, agent?: string): Promise<void> {
    if (
      !this.state.reportId ||
      !prompt.trim() ||
      prompt.length > 32000 ||
      this.state.sending ||
      this.state.restoring ||
      (!!this.state.restoreRunId && !this.state.receipt) ||
      (this.state.run?.status === "completed" && !this.state.committed) ||
      (this.state.receipt && !isTerminal(this.state.run?.status ?? "created"))
    )
      return;
    const input = {
      expected_version: version,
      prompt: prompt.trim(),
      ...(agent ? { agent_id: agent } : {}),
    };
    if (
      this.state.uncertain &&
      this.pending &&
      JSON.stringify(input) !==
        JSON.stringify({
          expected_version: this.pending.expected_version,
          prompt: this.pending.prompt,
          ...(this.pending.agent_id ? { agent_id: this.pending.agent_id } : {}),
        })
    )
      return;
    if (!this.pending) this.pending = { ...input, idempotency_key: createUuid() };
    const generation = this.generation;
    this.state.sending = true;
    this.state.error = "";
    this.dependencies.lock(true);
    try {
      const receipt = narrativeReceiptSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(this.state.reportId)}/revisions`,
          { method: "POST", body: this.pending, signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return;
      this.state.version = this.pending.expected_version;
      this.pending = undefined;
      this.state.receipt = receipt;
      this.state.run = null;
      this.state.committed = false;
      this.state.uncertain = false;
      this.state.progress = "";
      this.state.events = [];
      this.cursor = 0;
      this.connect();
    } catch (error) {
      if (!this.current(generation)) return;
      this.failed(error);
      if (!this.current(generation)) return;
      this.state.uncertain = !(
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      );
      if (!this.state.uncertain) {
        this.pending = undefined;
        this.dependencies.lock(false);
      }
    } finally {
      if (this.current(generation)) this.state.sending = false;
    }
  }
  private accept(run: AnalysisRunState): void {
    const identity = this.dependencies.identity(),
      receipt = this.state.receipt;
    if (
      !identity ||
      run.user_id !== identity.userId ||
      run.organization_id !== identity.organizationId ||
      run.analysis_run_id !== receipt?.analysis_run_id ||
      run.conversation_id !== receipt.conversation_id
    )
      throw new ApiError("修改任务归属不一致", 403);
    if (!this.state.run || run.sequence >= this.state.run.sequence) this.state.run = run;
  }
  private event(event: SseEvent): void {
    if (event.sequence <= this.cursor) return;
    this.cursor = event.sequence;
    this.state.events = [...this.state.events, event];
    if (event.type === "progress") this.state.progress = event.message;
    if (event.type === "context_compaction")
      this.state.progress = event.status === "started" ? "正在整理上下文…" : "上下文整理完成";
    const run = this.state.run;
    if (!run || event.sequence <= run.sequence) return;
    let status = run.status;
    if (event.type === "run_state") status = event.status;
    if (event.type === "run_started" || event.type === "clarification_answered") status = "running";
    if (event.type === "clarification") status = "waiting_clarification";
    if (event.type === "run_completed") status = "completed";
    if (event.type === "run_failed") status = "failed";
    if (event.type === "run_cancelled") status = "cancelled";
    this.state.run = {
      ...run,
      status,
      sequence: event.sequence,
      clarification:
        event.type === "clarification" && event.clarification_id
          ? {
              clarification_id: event.clarification_id,
              question: event.question,
              options: event.options,
              allow_custom_input: event.allow_custom_input,
              preference_confirmation_id: event.preference_confirmation_id,
            }
          : event.type === "clarification_answered" || isTerminal(status)
            ? null
            : run.clarification,
      error: event.type === "run_failed" ? { code: event.code, message: event.message } : run.error,
    };
  }
  connect(): void {
    const receipt = this.state.receipt;
    if (!receipt) return;
    this.subscription?.abort();
    const connection = new AbortController();
    this.subscription = connection;
    const generation = this.generation,
      signal = AbortSignal.any([this.controller.signal, connection.signal]);
    this.state.error = "";
    this.dependencies.lock(true);
    void subscribeRun({
      conversationId: receipt.conversation_id,
      runId: receipt.analysis_run_id,
      initialCursor: this.cursor,
      signal,
      open: (cursor, currentSignal) =>
        this.dependencies.stream(
          `/api/analysis-runs/${encodeURIComponent(receipt.analysis_run_id)}/events`,
          cursor,
          currentSignal,
        ),
      snapshot: async (currentSignal) =>
        analysisRunSchema.parse(
          await this.dependencies.request(
            `/api/analysis-runs/${encodeURIComponent(receipt.analysis_run_id)}`,
            { signal: currentSignal },
          ),
        ),
      onSnapshot: (run) => {
        if (this.current(generation) && !signal.aborted) this.accept(run);
      },
      onEvent: (event) => {
        if (this.current(generation) && !signal.aborted) this.event(event);
      },
      onConnection: (state) => {
        if (this.current(generation) && !signal.aborted) this.state.connection = state;
      },
    })
      .then(async () => {
        if (!this.current(generation) || signal.aborted) return;
        if (this.state.run?.status === "completed" && !this.state.committed) {
          await this.dependencies.commit(this.state.version + 1);
          if (!this.current(generation) || signal.aborted) return;
          this.state.committed = true;
        }
        this.dependencies.lock(false);
      })
      .catch((error: unknown) => {
        if (this.current(generation) && !signal.aborted) this.failed(error);
      });
  }
  async answer(value: { option_id?: string; custom_input?: string }): Promise<void> {
    const question = this.state.run?.clarification;
    if (!question || this.state.answering) return;
    const signature = JSON.stringify([question.clarification_id, value]);
    if (this.answerKey?.signature !== signature) this.answerKey = { signature, key: createUuid() };
    await this.action(
      "answers",
      clarificationAnswerSchema.parse({
        ...value,
        clarification_id: question.clarification_id,
        idempotency_key: this.answerKey.key,
      }),
    );
  }
  async cancel(): Promise<void> {
    if (!this.state.cancelling) await this.action("cancel");
  }
  private async action(action: "answers" | "cancel", body?: unknown): Promise<void> {
    const receipt = this.state.receipt;
    if (!receipt) return;
    const generation = this.generation,
      field = action === "answers" ? "answering" : "cancelling";
    this.state[field] = true;
    this.state.error = "";
    try {
      const run = analysisRunSchema.parse(
        await this.dependencies.request(
          `/api/analysis-runs/${encodeURIComponent(receipt.analysis_run_id)}/${action}`,
          { method: "POST", body, signal: this.controller.signal },
        ),
      );
      if (this.current(generation)) {
        this.accept(run);
        this.connect();
      }
    } catch (error) {
      if (this.current(generation)) this.failed(error);
    } finally {
      if (this.current(generation)) this.state[field] = false;
    }
  }
}
export { ReportRevisions };
