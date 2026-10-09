import { shallowReactive } from "vue";
import {
  reportListSchema,
  reportDefinitionVersionSchema,
  reportVersionListSchema,
  reportExecutionSchema,
  reportExecutionInputSchema,
  savedReportSchema,
} from "@ai-data/contracts";
import type { ReportExecution } from "@ai-data/contracts";
import { createUuid } from "../../../shared/identity/create-uuid";
import { ApiError } from "../../../shared/http/api-error";
import type { ParameterValues } from "../models/parameter-types";
import type { ReportDependencies, ReportState } from "./report-workspace-types";
function initialState(): ReportState {
  return {
    reportId: "",
    items: [],
    listing: false,
    listError: "",
    loading: false,
    versions: { definitions: [], snapshots: [] },
    definition: null,
    snapshot: null,
    execution: null,
    displayExecution: null,
    definitionError: "",
    resultError: "",
    historyError: "",
    executionError: "",
    sending: false,
    refreshing: false,
    selecting: false,
    uncertain: false,
  };
}
function reportError(error: unknown): string {
  return error instanceof ApiError
    ? `${error.message}${error.requestId ? `（请求编号 ${error.requestId}）` : ""}`
    : error instanceof Error && error.name !== "ZodError"
      ? error.message
      : "服务响应格式不符合报表合同，请重新读取";
}
/** 所有页面数据随身份或报表切换释放；版本选择只执行读取。 */
class ReportWorkspace {
  readonly state = shallowReactive<ReportState>(initialState());
  private page = new AbortController();
  private result = new AbortController();
  private generation = 0;
  private definitionSequence = 0;
  private resultSequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polls = 0;
  private pending?: {
    signature: string;
    body: ReturnType<typeof reportExecutionInputSchema.parse>;
  };
  private unregister: () => void;
  constructor(private readonly dependencies: ReportDependencies) {
    this.unregister = dependencies.resources.register(() => this.leave());
  }
  private current(generation: number) {
    return this.generation === generation && !this.page.signal.aborted;
  }
  private authorize(value: { organization_id: string; report_id: string }): void {
    if (
      value.organization_id !== this.dependencies.identity()?.organizationId ||
      value.report_id !== this.state.reportId
    )
      throw new ApiError("报表响应归属不一致", 403);
  }
  private failure(error: unknown): string {
    if (error instanceof ApiError && [401, 403].includes(error.status)) this.leave();
    return reportError(error);
  }
  leave(): void {
    this.page.abort();
    this.result.abort();
    clearTimeout(this.timer);
    this.generation++;
    this.pending = undefined;
    Object.assign(this.state, initialState(), { nextCursor: undefined });
  }
  dispose(): void {
    this.leave();
    this.unregister();
  }
  async list(more = false): Promise<void> {
    if (this.state.listing || (more && !this.state.nextCursor)) return;
    if (!more) {
      this.leave();
      this.page = new AbortController();
    }
    const generation = this.generation;
    this.state.listing = true;
    this.state.listError = "";
    const cursor = more ? `&cursor=${encodeURIComponent(this.state.nextCursor!)}` : "";
    try {
      const page = reportListSchema.parse(
        await this.dependencies.request(`/api/reports?limit=20${cursor}`, {
          signal: this.page.signal,
        }),
      );
      if (!this.current(generation)) return;
      this.state.items = [
        ...new Map(
          [...this.state.items, ...page.items].map((item) => [item.report_id, item]),
        ).values(),
      ];
      this.state.nextCursor = page.next_cursor;
    } catch (error) {
      if (this.current(generation)) this.state.listError = this.failure(error);
    } finally {
      if (generation === this.generation) this.state.listing = false;
    }
  }
  async open(id: string, executionId?: string, version?: number): Promise<void> {
    this.leave();
    this.page = new AbortController();
    this.result = new AbortController();
    this.state.reportId = id;
    this.state.loading = true;
    const generation = this.generation;
    await this.refreshHistory();
    if (!this.current(generation)) return;
    const versions = this.state.versions;
    const readingDefinition = versions.definitions.length
      ? this.selectDefinition(Math.max(...versions.definitions.map((item) => item.version)))
      : Promise.resolve();
    if (executionId) await this.selectExecution(executionId);
    else if (versions.snapshots.length)
      await this.selectSnapshot(
        version ?? Math.max(...versions.snapshots.map((item) => item.version)),
      );
    await readingDefinition;
    if (this.current(generation)) this.state.loading = false;
  }
  async refreshHistory(): Promise<void> {
    const generation = this.generation;
    this.state.historyError = "";
    try {
      const versions = reportVersionListSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(this.state.reportId)}/versions`,
          { signal: this.page.signal },
        ),
      );
      if (!this.current(generation)) return;
      [...versions.definitions, ...versions.snapshots].forEach((value) => this.authorize(value));
      this.state.versions = versions;
    } catch (error) {
      if (this.current(generation)) this.state.historyError = this.failure(error);
    }
  }
  async selectDefinition(version: number): Promise<void> {
    if (this.state.sending) return;
    const generation = this.generation,
      sequence = ++this.definitionSequence;
    this.state.definition = null;
    this.state.definitionError = "";
    try {
      const definition = reportDefinitionVersionSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(this.state.reportId)}/definition?version=${version}`,
          { signal: this.page.signal },
        ),
      );
      if (!this.current(generation) || sequence !== this.definitionSequence) return;
      this.authorize(definition);
      if (definition.version !== version)
        throw new ApiError("定义版本不匹配", 0, "INVALID_RESPONSE");
      this.state.definition = definition;
    } catch (error) {
      if (this.current(generation) && sequence === this.definitionSequence)
        this.state.definitionError = this.failure(error);
    }
  }
  private beginResult() {
    this.result.abort();
    this.result = new AbortController();
    clearTimeout(this.timer);
    this.polls = 0;
    this.resultSequence++;
    this.state.selecting = true;
    this.state.refreshing = false;
    this.state.uncertain = false;
    this.state.snapshot = null;
    this.state.displayExecution = null;
    this.state.execution = null;
    this.state.resultError = "";
    this.state.executionError = "";
    return this.resultSequence;
  }
  private resultCurrent(generation: number, sequence: number) {
    return this.current(generation) && sequence === this.resultSequence;
  }
  private signal() {
    return AbortSignal.any([this.page.signal, this.result.signal]);
  }
  private accept(record: ReportExecution): void {
    this.authorize(record);
    clearTimeout(this.timer);
    this.state.execution = record;
    if (record.status === "completed") {
      this.state.displayExecution = record;
      this.state.snapshot = record.snapshot!;
    }
    if (record.status === "running" && this.polls < 10) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.polls++;
        void this.refreshExecution();
      }, 2000);
    }
  }
  async selectExecution(id: string): Promise<void> {
    if (this.state.sending) return;
    const generation = this.generation,
      sequence = this.beginResult();
    try {
      const record = reportExecutionSchema.parse(
        await this.dependencies.request(`/api/report-executions/${encodeURIComponent(id)}`, {
          signal: this.signal(),
        }),
      );
      if (!this.resultCurrent(generation, sequence)) return;
      if (record.execution_id !== id) throw new ApiError("执行记录不匹配", 403);
      this.accept(record);
    } catch (error) {
      if (this.resultCurrent(generation, sequence)) this.state.resultError = this.failure(error);
    } finally {
      if (this.resultCurrent(generation, sequence)) this.state.selecting = false;
    }
  }
  async selectSnapshot(version: number): Promise<void> {
    if (this.state.sending) return;
    const generation = this.generation,
      sequence = this.beginResult();
    try {
      const snapshot = savedReportSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(this.state.reportId)}?version=${version}`,
          { signal: this.signal() },
        ),
      );
      if (!this.resultCurrent(generation, sequence)) return;
      this.authorize(snapshot);
      if (snapshot.version !== version) throw new ApiError("结果版本不匹配", 403);
      this.state.snapshot = snapshot;
      if (snapshot.execution_id) {
        const record = reportExecutionSchema.parse(
          await this.dependencies.request(
            `/api/report-executions/${encodeURIComponent(snapshot.execution_id)}`,
            { signal: this.signal() },
          ),
        );
        if (!this.resultCurrent(generation, sequence)) return;
        if (record.snapshot?.version !== version || record.execution_id !== snapshot.execution_id)
          throw new ApiError("快照执行记录不匹配", 403);
        this.accept(record);
      }
    } catch (error) {
      if (this.resultCurrent(generation, sequence)) this.state.resultError = this.failure(error);
    } finally {
      if (this.resultCurrent(generation, sequence)) this.state.selecting = false;
    }
  }
  async refreshExecution(): Promise<void> {
    const id = this.state.execution?.execution_id;
    if (!id || this.state.refreshing || this.state.sending) return;
    const generation = this.generation,
      sequence = this.resultSequence;
    this.state.refreshing = true;
    this.state.executionError = "";
    try {
      const record = reportExecutionSchema.parse(
        await this.dependencies.request(`/api/report-executions/${encodeURIComponent(id)}`, {
          signal: this.signal(),
        }),
      );
      if (!this.resultCurrent(generation, sequence)) return;
      if (record.execution_id !== id) throw new ApiError("执行记录不匹配", 403);
      const completed = this.state.execution?.status === "running" && record.status === "completed";
      this.accept(record);
      if (completed) await this.refreshHistory();
    } catch (error) {
      if (this.resultCurrent(generation, sequence)) this.state.executionError = this.failure(error);
    } finally {
      if (this.resultCurrent(generation, sequence)) this.state.refreshing = false;
    }
  }
  async execute(parameters: ParameterValues): Promise<void> {
    if (!this.state.definition || this.state.sending || this.state.execution?.status === "running")
      return;
    clearTimeout(this.timer);
    const definitionVersion = this.state.definition.version;
    const ordered = Object.fromEntries(
      Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)),
    );
    const signature = JSON.stringify([definitionVersion, ordered]);
    if (signature !== this.pending?.signature)
      this.pending = {
        signature,
        body: reportExecutionInputSchema.parse({
          definition_version: definitionVersion,
          parameters: ordered,
          idempotency_key: createUuid(),
        }),
      };
    const generation = this.generation,
      sequence = this.resultSequence;
    this.state.sending = true;
    this.state.executionError = "";
    this.state.uncertain = false;
    try {
      const record = reportExecutionSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(this.state.reportId)}/execute`,
          { method: "POST", body: this.pending.body, signal: this.signal(), timeoutMs: 150_000 },
        ),
      );
      if (!this.resultCurrent(generation, sequence)) return;
      if (record.definition_version !== definitionVersion)
        throw new ApiError("执行定义版本不匹配", 403);
      this.polls = 0;
      this.accept(record);
      this.pending = undefined;
      // 历史失败独立反馈，执行成功不会被历史读取覆盖。
      if (record.status === "completed") await this.refreshHistory();
    } catch (error) {
      if (this.resultCurrent(generation, sequence)) {
        const uncertain = !(error instanceof ApiError && error.status >= 400 && error.status < 500);
        this.state.executionError = this.failure(error);
        if (this.current(generation)) this.state.uncertain = uncertain;
      }
    } finally {
      if (this.resultCurrent(generation, sequence)) this.state.sending = false;
    }
  }
}
export { ReportWorkspace, reportError };
