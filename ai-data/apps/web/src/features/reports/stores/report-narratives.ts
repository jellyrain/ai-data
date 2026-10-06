import { shallowReactive } from "vue";
import { analysisRunSchema, clarificationAnswerSchema } from "@ai-data/contracts";
import type { AnalysisRunState, SseEvent } from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
import { subscribeRun, isTerminal } from "../../../shared/stream/run-stream";
import { narrativeListSchema, narrativeReceiptSchema } from "../api/report-schema";
import { reportError } from "./report-workspace";
import type {
  NarrativeDependencies,
  NarrativeReceipt,
  NarrativeState,
} from "./report-narrative-types";
function initialState(): NarrativeState {
  return {
    executionId: "",
    items: [],
    receipt: null,
    run: null,
    loading: false,
    sending: false,
    answering: false,
    cancelling: false,
    error: "",
    connection: "",
    progress: "",
    uncertain: false,
  };
}
/** SSE 只展示过程；已保存说明的执行归属由 GET narratives 合同复核。 */
class ReportNarratives {
  readonly state = shallowReactive<NarrativeState>(initialState());
  private controller = new AbortController();
  private subscription?: AbortController;
  private generation = 0;
  private cursor = 0;
  private pending?: { prompt: string; key: string };
  private answerKey?: { signature: string; key: string };
  private unregister: () => void;
  constructor(private readonly dependencies: NarrativeDependencies) {
    this.unregister = dependencies.resources.register(() => this.leave());
  }
  private current(generation: number) {
    return generation === this.generation && !this.controller.signal.aborted;
  }
  leave(): void {
    this.controller.abort();
    this.subscription?.abort();
    this.generation++;
    this.cursor = 0;
    this.pending = undefined;
    this.answerKey = undefined;
    Object.assign(this.state, initialState());
  }
  dispose(): void {
    this.leave();
    this.unregister();
  }
  async select(id: string): Promise<void> {
    this.leave();
    this.controller = new AbortController();
    this.state.executionId = id;
    if (id) await this.load();
  }
  private failed(error: unknown) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      this.leave();
      this.dependencies.onDenied?.(reportError(error));
    }
    this.state.error = reportError(error);
  }
  async load(): Promise<void> {
    if (!this.state.executionId) return;
    const generation = this.generation;
    this.state.loading = true;
    this.state.error = "";
    try {
      const response = narrativeListSchema.parse(
        await this.dependencies.request(
          `/api/report-executions/${encodeURIComponent(this.state.executionId)}/narratives`,
          { signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return;
      if (response.items.some((item) => item.execution_id !== this.state.executionId))
        throw new ApiError("分析说明的执行归属不一致", 403);
      this.state.items = response.items;
    } catch (error) {
      if (this.current(generation)) this.failed(error);
    } finally {
      if (this.current(generation)) this.state.loading = false;
    }
  }
  async start(prompt: string): Promise<void> {
    if (
      !this.state.executionId ||
      this.state.sending ||
      (this.state.receipt && (!this.state.run || !isTerminal(this.state.run.status))) ||
      !prompt.trim() ||
      prompt.length > 32000
    )
      return;
    const generation = this.generation;
    if (this.pending?.prompt !== prompt.trim())
      this.pending = { prompt: prompt.trim(), key: crypto.randomUUID() };
    this.state.sending = true;
    this.state.error = "";
    try {
      const receipt = narrativeReceiptSchema.parse(
        await this.dependencies.request(
          `/api/report-executions/${encodeURIComponent(this.state.executionId)}/narratives`,
          {
            method: "POST",
            body: { prompt: this.pending.prompt, idempotency_key: this.pending.key },
            signal: this.controller.signal,
          },
        ),
      );
      if (!this.current(generation)) return;
      this.pending = undefined;
      this.state.uncertain = false;
      this.restore(receipt);
    } catch (error) {
      if (this.current(generation)) {
        const uncertain = !(error instanceof ApiError && error.status >= 400 && error.status < 500);
        this.failed(error);
        if (this.current(generation)) this.state.uncertain = uncertain;
      }
    } finally {
      if (this.current(generation)) this.state.sending = false;
    }
  }
  restore(receipt: NarrativeReceipt): void {
    if (!this.state.executionId) return;
    this.subscription?.abort();
    this.state.receipt = narrativeReceiptSchema.parse(receipt);
    this.cursor = 0;
    this.state.run = null;
    this.state.progress = "";
    this.connect();
  }
  private accept(snapshot: AnalysisRunState): void {
    const identity = this.dependencies.identity(),
      receipt = this.state.receipt;
    if (
      snapshot.user_id !== identity?.userId ||
      snapshot.organization_id !== identity.organizationId ||
      snapshot.conversation_id !== receipt?.conversation_id ||
      snapshot.analysis_run_id !== receipt.analysis_run_id
    )
      throw new ApiError("说明运行归属不一致", 403);
    if (!this.state.run || snapshot.sequence >= this.state.run.sequence) this.state.run = snapshot;
  }
  private event(event: SseEvent): void {
    this.cursor = event.sequence;
    if (event.type === "progress") this.state.progress = event.message;
    if (event.type === "context_compaction")
      this.state.progress =
        event.status === "started" ? "正在整理对话上下文…" : "上下文整理完成，继续分析";
    const run = this.state.run;
    if (!run || event.sequence <= run.sequence) return;
    let status = run.status;
    if (event.type === "run_state") status = event.status;
    if (event.type === "run_started" || event.type === "clarification_answered") status = "running";
    if (event.type === "clarification") status = "waiting_clarification";
    if (event.type === "run_completed") status = "completed";
    if (event.type === "run_cancelled") status = "cancelled";
    if (event.type === "run_failed") status = "failed";
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
      onSnapshot: (value) => {
        if (this.current(generation) && !signal.aborted) this.accept(value);
      },
      onEvent: (value) => {
        if (this.current(generation) && !signal.aborted) this.event(value);
      },
      onConnection: (value) => {
        if (this.current(generation) && !signal.aborted) this.state.connection = value;
      },
    })
      .then(async () => {
        if (this.current(generation) && !signal.aborted) await this.load();
      })
      .catch((error: unknown) => {
        if (this.current(generation) && !signal.aborted) this.failed(error);
      });
  }
  async answer(value: { option_id?: string; custom_input?: string }): Promise<void> {
    const question = this.state.run?.clarification;
    if (!question || this.state.answering || !this.state.receipt) return;
    const signature = JSON.stringify([question.clarification_id, value]);
    if (this.answerKey?.signature !== signature)
      this.answerKey = { signature, key: crypto.randomUUID() };
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
    if (!this.state.receipt) return;
    const generation = this.generation,
      receipt = this.state.receipt;
    const field = action === "answers" ? "answering" : "cancelling";
    this.state[field] = true;
    this.state.error = "";
    try {
      const snapshot = analysisRunSchema.parse(
        await this.dependencies.request(
          `/api/analysis-runs/${encodeURIComponent(receipt.analysis_run_id)}/${action}`,
          { method: "POST", body, signal: this.controller.signal },
        ),
      );
      if (this.current(generation)) this.accept(snapshot);
    } catch (error) {
      if (this.current(generation)) this.failed(error);
    } finally {
      if (this.current(generation)) this.state[field] = false;
    }
  }
}
export { ReportNarratives };
