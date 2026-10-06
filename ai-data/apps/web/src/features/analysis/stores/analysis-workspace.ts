import { shallowReactive } from "vue";
import {
  agentVersionSchema,
  analysisRunSchema,
  clarificationAnswerSchema,
  createConversationSchema,
  submitMessageSchema,
} from "@ai-data/contracts";
import type { AgentVersion, AnalysisRunState, SseEvent } from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
import { subscribeRun, isTerminal } from "../../../shared/stream/run-stream";
import {
  agentListSchema,
  conversationDetailSchema,
  conversationListSchema,
  conversationSchema,
  evidenceListSchema,
  stepListSchema,
  submittedMessageSchema,
} from "../api/analysis-schema";
import type {
  PendingMessage,
  RunView,
  WorkspaceDependencies,
  WorkspaceState,
} from "./analysis-workspace-types";

function initialState(): WorkspaceState {
  return {
    conversations: [],
    agents: [],
    detail: null,
    boundAgent: null,
    runs: {},
    draft: "",
    loading: false,
    sending: false,
    creating: false,
    answering: false,
    cancelling: false,
    pendingMessage: false,
    creationUncertain: false,
    error: "",
    listError: "",
  };
}
function errorText(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.message}${error.requestId ? `（请求编号 ${error.requestId}）` : ""}`;
  return "服务响应未能确认，请检查连接后重试";
}
/** 会话和草稿按应用身份隔离；切页释放结果，退出经统一入口销毁全部内存。 */
class AnalysisWorkspace {
  readonly state = shallowReactive<WorkspaceState>(initialState());
  private generation = 0;
  private selected = "";
  private page = new AbortController();
  private drafts = new Map<string, string>();
  private pending = new Map<string, PendingMessage>();
  private answers = new Map<string, { value: string; key: string }>();
  private subscriptions = new Map<string, AbortController>();
  private evidenceTasks = new Map<string, Promise<void>>();
  private unregister: () => void;
  constructor(private readonly dependencies: WorkspaceDependencies) {
    this.unregister = dependencies.resources.register(() => this.reset());
  }
  private current(generation: number): boolean {
    return generation === this.generation && !this.page.signal.aborted;
  }
  private assertIdentity(value: { userId: string; organizationId: string }): void {
    const identity = this.dependencies.identity();
    if (
      !identity ||
      identity.userId !== value.userId ||
      identity.organizationId !== value.organizationId
    )
      throw new ApiError("当前数据归属不一致", 403, "FORBIDDEN");
  }
  private failed(error: unknown): void {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      this.page.abort();
      this.subscriptions.clear();
      this.evidenceTasks.clear();
      this.state.detail = null;
      this.state.runs = {};
      this.state.boundAgent = null;
      this.pending.delete(this.selected);
      this.drafts.delete(this.selected);
      this.state.draft = "";
      this.state.pendingMessage = false;
    }
    this.state.error = errorText(error);
  }
  setDraft(value: string): void {
    this.state.draft = value;
    this.drafts.set(this.selected, value);
  }
  leave(): void {
    this.page.abort();
    this.generation++;
    this.subscriptions.clear();
    this.evidenceTasks.clear();
    this.state.detail = null;
    this.state.runs = {};
    this.state.boundAgent = null;
    this.state.loading = false;
    this.state.sending = false;
    this.state.answering = false;
    this.state.cancelling = false;
    this.state.creating = false;
  }
  reset(): void {
    this.leave();
    this.drafts.clear();
    this.pending.clear();
    this.answers.clear();
    this.selected = "";
    Object.assign(this.state, initialState());
  }
  dispose(): void {
    this.reset();
    this.unregister();
  }
  /** 每次进入都复核会话权限，迟到的旧页面请求不会提交到新页面。 */
  async enter(id = "", force = false): Promise<void> {
    if (!force && id && this.state.detail?.conversation.id === id && !this.page.signal.aborted)
      return;
    this.leave();
    this.page = new AbortController();
    this.selected = id;
    const generation = this.generation;
    this.state.draft = this.drafts.get(id) ?? "";
    this.state.pendingMessage = this.pending.has(id);
    this.state.error = "";
    this.state.loading = true;
    const listing = this.refreshLists();
    try {
      if (id) {
        const detail = conversationDetailSchema.parse(
          await this.dependencies.request(`/api/conversations/${encodeURIComponent(id)}`, {
            signal: this.page.signal,
          }),
        );
        if (!this.current(generation)) return;
        if (detail.conversation.id !== id)
          throw new ApiError("会话响应不一致", 0, "INVALID_RESPONSE");
        this.assertIdentity(detail.conversation);
        this.state.detail = {
          ...detail,
          messages: [...detail.messages].sort((a, b) => a.sequence - b.sequence),
        };
        const conversation = detail.conversation;
        if (conversation.agentId && conversation.agentVersion) {
          const agent = agentVersionSchema.parse(
            await this.dependencies.request(
              `/api/agents/${encodeURIComponent(conversation.agentId)}?version=${conversation.agentVersion}`,
              { signal: this.page.signal },
            ),
          );
          if (this.current(generation)) {
            if (
              agent.agent_id !== conversation.agentId ||
              agent.version !== conversation.agentVersion
            )
              throw new ApiError("Agent 版本响应不一致", 0, "INVALID_RESPONSE");
            this.state.boundAgent = agent;
          }
        }
      }
    } catch (error) {
      if (this.current(generation)) this.failed(error);
    } finally {
      await listing;
      if (generation === this.generation) this.state.loading = false;
    }
  }
  async refreshLists(): Promise<void> {
    const generation = this.generation;
    this.state.listError = "";
    try {
      const [conversations, agents] = await Promise.all([
        this.dependencies.request("/api/conversations", { signal: this.page.signal }),
        this.dependencies.request("/api/agents", { signal: this.page.signal }),
      ]);
      if (!this.current(generation)) return;
      const items = conversationListSchema.parse(conversations).items;
      items.forEach((item) => this.assertIdentity(item));
      this.state.conversations = items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      this.state.agents = agentListSchema.parse(agents).items.filter((agent) => agent.enabled);
    } catch (error) {
      if (this.current(generation)) {
        this.state.listError = errorText(error);
        if (error instanceof ApiError && [401, 403].includes(error.status)) this.failed(error);
      }
    }
  }
  /** 创建请求不自动重试；不确定时先显示已复核列表，再由用户明确再建。 */
  async create(agent: AgentVersion): Promise<string | null> {
    if (this.state.creating || this.state.creationUncertain || !agent.enabled) return null;
    const generation = this.generation;
    const draft = this.state.draft;
    this.state.creating = true;
    this.state.error = "";
    try {
      const body = createConversationSchema.parse({
        title: draft.trim().slice(0, 80) || "新分析",
        agent_id: agent.agent_id,
        agent_version: agent.version,
      });
      const conversation = conversationSchema.parse(
        await this.dependencies.request("/api/conversations", {
          method: "POST",
          body,
          signal: this.page.signal,
        }),
      );
      if (!this.current(generation)) return null;
      this.assertIdentity(conversation);
      this.selected = conversation.id;
      this.state.detail = { conversation, messages: [] };
      this.state.boundAgent = agent;
      this.drafts.set(conversation.id, draft);
      this.drafts.delete("");
      this.state.pendingMessage = false;
      this.state.conversations = [
        conversation,
        ...this.state.conversations.filter((item) => item.id !== conversation.id),
      ];
      return conversation.id;
    } catch (error) {
      if (this.current(generation)) {
        this.state.creationUncertain = !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        );
        this.failed(error);
        await this.refreshLists();
      }
      return null;
    } finally {
      if (generation === this.generation) this.state.creating = false;
    }
  }
  confirmCreateRetry(): void {
    this.state.creationUncertain = false;
    this.state.error = "";
  }
  activeRun(): RunView | undefined {
    return Object.values(this.state.runs).find(
      (run) => !run.snapshot || !isTerminal(run.snapshot.status),
    );
  }
  async send(): Promise<void> {
    const detail = this.state.detail;
    if (
      !detail ||
      this.state.sending ||
      this.activeRun() ||
      detail.conversation.status !== "active"
    )
      return;
    const id = detail.conversation.id;
    const existing = this.pending.get(id);
    const content = existing?.content ?? this.state.draft.trim();
    if (!content || content.length > 64000) return;
    const submission = existing ?? { content, key: crypto.randomUUID() };
    this.pending.set(id, submission);
    this.state.pendingMessage = true;
    const generation = this.generation;
    this.state.sending = true;
    this.state.error = "";
    try {
      const body = submitMessageSchema.parse({
        content: submission.content,
        idempotency_key: submission.key,
      });
      const receipt = submittedMessageSchema.parse(
        await this.dependencies.request(`/api/conversations/${encodeURIComponent(id)}/messages`, {
          method: "POST",
          body,
          signal: this.page.signal,
        }),
      );
      if (!this.current(generation)) return;
      this.assertIdentity(receipt.analysisRun);
      if (receipt.message.conversationId !== id) throw new ApiError("消息回执归属不一致", 403);
      this.pending.delete(id);
      this.state.pendingMessage = false;
      this.setDraft("");
      const message = { ...receipt.message, analysisRunId: receipt.analysisRun.id };
      this.state.detail = {
        ...detail,
        messages: [...detail.messages.filter((item) => item.id !== message.id), message].sort(
          (a, b) => a.sequence - b.sequence,
        ),
      };
    } catch (error) {
      if (this.current(generation)) {
        if (error instanceof ApiError && error.status === 400) {
          this.pending.delete(id);
          this.state.pendingMessage = false;
        }
        this.failed(error);
        if (error instanceof ApiError && error.status === 409) await this.enter(id, true);
      }
    } finally {
      if (generation === this.generation) this.state.sending = false;
    }
  }
  private acceptSnapshot(run: RunView, snapshot: AnalysisRunState): void {
    if (snapshot.analysis_run_id !== run.id || snapshot.conversation_id !== this.selected)
      throw new ApiError("运行快照归属不一致", 403, "FORBIDDEN");
    this.assertIdentity({ userId: snapshot.user_id, organizationId: snapshot.organization_id });
    if (run.snapshot && snapshot.sequence < run.snapshot.sequence) return;
    if (
      snapshot.sequence > (run.snapshot?.sequence ?? 0) &&
      (isTerminal(snapshot.status) ||
        snapshot.evidence_ids.some((id) => !run.evidence.some((item) => item.evidence_id === id)))
    )
      run.evidenceLoaded = false;
    run.snapshot = snapshot;
  }
  /** 仅为已展示消息读取事件；终态历史同样回放，页面没有独立持久化游标。 */
  watchRun(id: string): void {
    const detail = this.state.detail;
    if (!detail || this.subscriptions.has(id)) return;
    let run = this.state.runs[id];
    if (!run) {
      run = shallowReactive<RunView>({
        id,
        snapshot: null,
        cursor: 0,
        events: [],
        connection: "connecting",
        error: "",
        evidence: [],
        steps: [],
        evidenceLoaded: false,
        evidenceLoading: false,
        evidenceError: "",
      });
      this.state.runs = { ...this.state.runs, [id]: run };
    }
    if (run.connection === "complete" || run.error) return;
    const view = run;
    const generation = this.generation;
    const controller = new AbortController();
    this.subscriptions.set(id, controller);
    void this.dependencies.resources
      .run(async (identitySignal) => {
        const signal = AbortSignal.any([this.page.signal, identitySignal, controller.signal]);
        await subscribeRun({
          conversationId: detail.conversation.id,
          runId: id,
          initialCursor: view.cursor,
          signal,
          open: (cursor, currentSignal) =>
            this.dependencies.stream(
              `/api/analysis-runs/${encodeURIComponent(id)}/events`,
              cursor,
              currentSignal,
            ),
          snapshot: async (currentSignal) =>
            analysisRunSchema.parse(
              await this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(id)}`, {
                signal: currentSignal,
              }),
            ),
          onSnapshot: (value) => {
            if (this.current(generation)) this.acceptSnapshot(view, value);
          },
          onConnection: (value) => {
            if (this.current(generation)) view.connection = value;
          },
          onEvent: (event) => {
            if (this.current(generation)) this.applyEvent(view, event);
          },
        });
      })
      .catch((error: unknown) => {
        if (!this.current(generation) || controller.signal.aborted) return;
        view.error = errorText(error);
        view.connection = "error";
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) this.failed(error);
      })
      .finally(() => {
        if (this.subscriptions.get(id) === controller) this.subscriptions.delete(id);
      });
  }
  private applyEvent(run: RunView, event: SseEvent): void {
    run.events = [...run.events, event];
    run.cursor = event.sequence;
    if (event.type === "table" || event.type === "run_completed") run.evidenceLoaded = false;
    const state = run.snapshot;
    if (!state || event.sequence <= state.sequence || isTerminal(state.status)) return;
    let status = state.status;
    if (event.type === "run_state") status = event.status;
    if (event.type === "run_started") status = "running";
    if (event.type === "run_completed") status = "completed";
    if (event.type === "run_failed") status = "failed";
    if (event.type === "run_cancelled") status = "cancelled";
    if (event.type === "clarification") status = "waiting_clarification";
    if (event.type === "clarification_answered") status = "created";
    const clarification =
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
          : state.clarification;
    run.snapshot = {
      ...state,
      status,
      clarification,
      sequence: event.sequence,
      lease_epoch: Math.max(state.lease_epoch, event.lease_epoch ?? 0),
      error:
        event.type === "run_failed" ? { code: event.code, message: event.message } : state.error,
    };
  }
  reconnect(id: string): void {
    const run = this.state.runs[id];
    if (!run) return;
    this.subscriptions.get(id)?.abort();
    this.subscriptions.delete(id);
    run.error = "";
    run.connection = "connecting";
    this.watchRun(id);
  }
  async answer(id: string, value: { option_id?: string; custom_input?: string }): Promise<void> {
    const run = this.state.runs[id];
    const question = run?.snapshot?.clarification;
    if (!question || this.state.answering) return;
    const generation = this.generation;
    const signature = JSON.stringify(value);
    const prior = this.answers.get(question.clarification_id);
    const pending =
      prior?.value === signature ? prior : { value: signature, key: crypto.randomUUID() };
    this.answers.set(question.clarification_id, pending);
    this.state.answering = true;
    this.state.error = "";
    try {
      const body = clarificationAnswerSchema.parse({
        ...value,
        clarification_id: question.clarification_id,
        idempotency_key: pending.key,
      });
      const snapshot = analysisRunSchema.parse(
        await this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(id)}/answers`, {
          method: "POST",
          body,
          signal: this.page.signal,
        }),
      );
      if (this.current(generation)) {
        this.acceptSnapshot(run, snapshot);
        this.answers.delete(question.clarification_id);
      }
    } catch (error) {
      if (this.current(generation)) {
        this.failed(error);
        if (error instanceof ApiError && error.status === 409) {
          try {
            const fresh = analysisRunSchema.parse(
              await this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(id)}`, {
                signal: this.page.signal,
              }),
            );
            if (this.current(generation)) this.acceptSnapshot(run, fresh);
          } catch (failure) {
            if (this.current(generation)) this.failed(failure);
          }
        }
      }
    } finally {
      if (generation === this.generation) this.state.answering = false;
    }
  }
  async cancel(id: string): Promise<void> {
    const run = this.state.runs[id];
    if (!run || this.state.cancelling) return;
    const generation = this.generation;
    this.state.cancelling = true;
    this.state.error = "";
    try {
      const snapshot = analysisRunSchema.parse(
        await this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          signal: this.page.signal,
        }),
      );
      if (this.current(generation)) this.acceptSnapshot(run, snapshot);
    } catch (error) {
      if (this.current(generation)) this.failed(error);
    } finally {
      if (generation === this.generation) this.state.cancelling = false;
    }
  }
  loadEvidence(id: string): Promise<void> {
    const run = this.state.runs[id];
    if (!run || run.evidenceLoaded) return Promise.resolve();
    const existing = this.evidenceTasks.get(id);
    if (existing) return existing;
    const generation = this.generation;
    run.evidenceLoading = true;
    const requestedSequence = Math.max(run.cursor, run.snapshot?.sequence ?? 0);
    run.evidenceError = "";
    const task = (async () => {
      try {
        const [raw, steps] = await Promise.all([
          this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(id)}/evidence`, {
            signal: this.page.signal,
          }),
          this.dependencies.request(`/api/analysis-runs/${encodeURIComponent(id)}/steps`, {
            signal: this.page.signal,
          }),
        ]);
        if (!this.current(generation)) return;
        const evidence = evidenceListSchema.parse(raw).items;
        const parsedSteps = stepListSchema.parse(steps).items;
        evidence.forEach((item) => {
          this.assertIdentity({ userId: item.user_id, organizationId: item.organization_id });
          if (
            item.analysis_run_id !== id ||
            item.result.rows.length > 5000 ||
            new TextEncoder().encode(JSON.stringify(item.result)).length > 2 * 1024 * 1024
          )
            throw new ApiError("证据内容超出约定范围", 0, "INVALID_RESPONSE");
        });
        if (parsedSteps.some((step) => step.analysis_run_id !== id))
          throw new ApiError("步骤归属不一致", 403);
        run.evidence = evidence;
        run.steps = parsedSteps;
        run.evidenceLoaded =
          requestedSequence === Math.max(run.cursor, run.snapshot?.sequence ?? 0);
      } catch (error) {
        if (this.current(generation)) {
          run.evidenceError = errorText(error);
          if (error instanceof ApiError && [401, 403, 404].includes(error.status))
            this.failed(error);
        }
      } finally {
        if (this.current(generation)) {
          run.evidenceLoading = false;
          this.evidenceTasks.delete(id);
        }
      }
    })();
    this.evidenceTasks.set(id, task);
    return task;
  }
}
export { AnalysisWorkspace };
