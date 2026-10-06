import { z } from "zod";
import { reactive } from "vue";
import {
  reportDefinitionSchema,
  reportDefinitionVersionSchema,
  stableStringify,
  sourceListSchema,
  relationGraphSchema,
  metricDefinitionSchema,
} from "@ai-data/contracts";
import type { ReportDefinition, ReportDefinitionVersion } from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
import { blankDefinition, cloneDefinition, definitionIssues } from "../models/definition-editor";
import { editorDatasetListSchema, editorMetricListSchema } from "../api/editor-schema";
import { agentListSchema } from "../../analysis/api/analysis-schema";
import { reportError } from "./report-workspace";
import type { ReportDependencies } from "./report-workspace-types";
import type { ReportEditorState } from "./report-editor-types";

function initialState(): ReportEditorState {
  return {
    reportId: "",
    baseline: null,
    latest: null,
    draft: blankDefinition(),
    loading: false,
    saving: false,
    ready: false,
    locked: false,
    uncertain: false,
    error: "",
    notice: "",
    issues: [],
    sources: [],
    loadingSources: false,
    datasets: {},
    relations: {},
    metrics: [],
    agents: [],
    catalogError: "",
  };
}
/** 编辑页面只提交定义；数据执行由详情页的显式操作负责。 */
class ReportEditor {
  readonly state = reactive<ReportEditorState>(initialState());
  private controller = new AbortController();
  private generation = 0;
  private unregister: () => void;
  private pending?: ReportDefinition;
  constructor(private readonly dependencies: ReportDependencies) {
    this.unregister = dependencies.resources.register(() => this.leave());
  }
  get dirty(): boolean {
    return (
      stableStringify(this.state.draft) !==
      stableStringify(this.state.baseline?.definition ?? blankDefinition())
    );
  }
  private current(generation: number): boolean {
    return generation === this.generation && !this.controller.signal.aborted;
  }
  leave(): void {
    this.controller.abort();
    this.generation++;
    this.pending = undefined;
    Object.assign(this.state, initialState(), { sourceCursor: undefined });
  }
  dispose(): void {
    this.leave();
    this.unregister();
  }
  private failure(error: unknown): void {
    if (error instanceof ApiError && [401, 403].includes(error.status)) this.leave();
    this.state.error = reportError(error);
  }
  private authorize(record: ReportDefinitionVersion): void {
    const identity = this.dependencies.identity();
    if (
      record.organization_id !== identity?.organizationId ||
      record.user_id !== identity?.userId ||
      (this.state.reportId && record.report_id !== this.state.reportId)
    )
      throw new ApiError("仅报表作者可以编辑此定义", 403);
  }
  private accept(record: ReportDefinitionVersion): void {
    this.authorize(record);
    this.state.reportId = record.report_id;
    this.state.baseline = record;
    this.state.draft = cloneDefinition(record.definition);
    this.state.latest = null;
    this.state.ready = true;
    this.state.uncertain = false;
    this.pending = undefined;
  }
  async open(id = ""): Promise<void> {
    this.leave();
    this.controller = new AbortController();
    this.state.reportId = id;
    if (!this.dependencies.identity()) return;
    if (!id) {
      this.state.ready = true;
      return;
    }
    const generation = this.generation;
    this.state.loading = true;
    try {
      const record = reportDefinitionVersionSchema.parse(
        await this.dependencies.request(`/api/reports/${encodeURIComponent(id)}/definition`, {
          signal: this.controller.signal,
        }),
      );
      if (this.current(generation)) this.accept(record);
    } catch (error) {
      if (this.current(generation)) this.failure(error);
    } finally {
      if (this.current(generation)) this.state.loading = false;
    }
  }
  /** 模板目录已经过当前访问者授权；只复制定义并建立新的个人草稿。 */
  async openTemplate(id: string, version: number): Promise<void> {
    await this.open();
    this.state.ready = false;
    if (!this.dependencies.identity()) return;
    const generation = this.generation;
    this.state.loading = true;
    try {
      const items = z
        .object({ items: z.array(reportDefinitionVersionSchema) })
        .strict()
        .parse(
          await this.dependencies.request("/api/report-templates", {
            signal: this.controller.signal,
          }),
        ).items;
      if (!this.current(generation)) return;
      const record = items.find(
        (item) =>
          item.report_id === id &&
          item.version === version &&
          item.organization_id === this.dependencies.identity()?.organizationId,
      );
      if (!record) throw new ApiError("此模板已停用、尚未生效或当前无权使用，请重新选择模板", 404);
      this.state.draft = cloneDefinition(record.definition);
      this.state.ready = true;
      this.state.notice = "已从模板创建草稿，请核对内容后保存为个人报表。";
    } catch (error) {
      if (this.current(generation)) this.failure(error);
    } finally {
      if (this.current(generation)) this.state.loading = false;
    }
  }
  update(value: ReportDefinition): void {
    if (!this.state.ready || this.state.saving || this.state.locked || this.state.uncertain) return;
    this.state.draft = cloneDefinition(value);
    this.state.notice = "";
    this.state.issues = [];
  }
  async save(): Promise<boolean> {
    if (
      !this.state.ready ||
      this.state.saving ||
      this.state.locked ||
      this.state.uncertain ||
      this.state.latest
    )
      return false;
    this.state.issues = definitionIssues(this.state.draft);
    if (this.state.issues.length) return false;
    const definition = reportDefinitionSchema.parse(this.state.draft),
      baseline = this.state.baseline;
    const generation = this.generation;
    this.state.saving = true;
    this.state.error = "";
    this.state.notice = "";
    this.pending = cloneDefinition(definition);
    const body = {
      definition,
      shared_with: baseline?.shared_with ?? [],
      ...(baseline?.source_analysis_run_id
        ? { source_analysis_run_id: baseline.source_analysis_run_id }
        : {}),
      ...(baseline?.source_artifact_id ? { source_artifact_id: baseline.source_artifact_id } : {}),
      ...(baseline ? { expected_version: baseline.version } : {}),
    };
    try {
      const record = reportDefinitionVersionSchema.parse(
        await this.dependencies.request(
          baseline
            ? `/api/reports/${encodeURIComponent(this.state.reportId)}/definition`
            : "/api/report-definitions",
          { method: baseline ? "PUT" : "POST", body, signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return false;
      this.accept(record);
      this.state.notice = `已保存版本 ${record.version}`;
      return true;
    } catch (error) {
      if (!this.current(generation)) return false;
      this.failure(error);
      if (!this.current(generation)) return false;
      if (error instanceof ApiError && error.status === 409 && baseline) await this.checkSaved();
      else
        this.state.uncertain = !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        );
      return false;
    } finally {
      if (this.current(generation)) this.state.saving = false;
    }
  }
  /** 有已知ID时只读核对；创建回执丢失必须先由用户核对报表中心。 */
  async checkSaved(): Promise<void> {
    if (!this.state.reportId) return;
    const generation = this.generation;
    try {
      const record = reportDefinitionVersionSchema.parse(
        await this.dependencies.request(
          `/api/reports/${encodeURIComponent(this.state.reportId)}/definition`,
          { signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return;
      this.authorize(record);
      if (
        this.pending &&
        record.version > (this.state.baseline?.version ?? 0) &&
        stableStringify(record.definition) === stableStringify(this.pending)
      ) {
        this.accept(record);
        this.state.error = "";
        this.state.notice = `已确认保存为版本 ${record.version}`;
      } else {
        this.state.latest = record;
        this.state.uncertain = false;
      }
    } catch (error) {
      if (this.current(generation)) this.failure(error);
    }
  }
  resolveConflict(choice: "local" | "server"): void {
    const latest = this.state.latest;
    if (!latest || this.state.locked) return;
    const draft = cloneDefinition(this.state.draft);
    this.accept(latest);
    if (choice === "local") this.state.draft = draft;
    this.state.error = "";
    this.state.notice =
      choice === "local"
        ? `当前草稿将基于版本 ${latest.version} 保存`
        : `已采用版本 ${latest.version}`;
  }
  allowCreateRetry(): void {
    if (!this.state.reportId) {
      this.state.uncertain = false;
      this.state.error = "";
    }
  }
  discard(): void {
    if (this.state.baseline) {
      this.state.draft = cloneDefinition(this.state.baseline.definition);
      this.state.issues = [];
    }
  }
  /** AI成功终态后读取准确提交版本，避免把后续人工版本当作本次修改。 */
  async acceptRevision(version: number): Promise<void> {
    const generation = this.generation;
    const record = reportDefinitionVersionSchema.parse(
      await this.dependencies.request(
        `/api/reports/${encodeURIComponent(this.state.reportId)}/definition?version=${version}`,
        { signal: this.controller.signal },
      ),
    );
    if (!this.current(generation)) return;
    if (record.version !== version) throw new ApiError("返回的修改版本不一致");
    this.accept(record);
    this.state.notice = `AI 修改已保存为版本 ${version}`;
  }
  async loadSources(more = false): Promise<void> {
    if (this.state.loadingSources || (more && !this.state.sourceCursor)) return;
    const generation = this.generation;
    this.state.loadingSources = true;
    this.state.catalogError = "";
    try {
      const result = sourceListSchema.parse(
        await this.dependencies.request(
          `/api/catalog/sources?limit=100${more ? `&cursor=${encodeURIComponent(this.state.sourceCursor!)}` : ""}`,
          { signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return;
      this.state.sources = [
        ...new Map(
          [...(more ? this.state.sources : []), ...result.items].map((s) => [s.source_id, s]),
        ).values(),
      ];
      this.state.sourceCursor = result.next_cursor;
    } catch (error) {
      if (this.current(generation)) this.catalogFailure(error);
    } finally {
      if (this.current(generation)) this.state.loadingSources = false;
    }
  }
  private catalogFailure(error: unknown): void {
    if (error instanceof ApiError && [401, 403].includes(error.status)) this.failure(error);
    else this.state.catalogError = reportError(error);
  }
  async loadDatasets(source: string, refresh = false): Promise<void> {
    if (!source || (!refresh && this.state.datasets[source])) return;
    const generation = this.generation;
    this.state.catalogError = "";
    try {
      const result = editorDatasetListSchema.parse(
        await this.dependencies.request(`/api/catalog/datasets/${encodeURIComponent(source)}`, {
          signal: this.controller.signal,
        }),
      );
      if (!this.current(generation)) return;
      if (result.items.some((d) => d.source_id !== source))
        throw new ApiError("数据目录来源不一致", 403);
      this.state.datasets[source] = result.items;
    } catch (error) {
      if (this.current(generation)) this.catalogFailure(error);
    }
  }
  async loadRelations(source: string, object: string): Promise<void> {
    const generation = this.generation;
    this.state.catalogError = "";
    try {
      const result = relationGraphSchema.parse(
        await this.dependencies.request(
          `/api/catalog/${encodeURIComponent(source)}/objects/${encodeURIComponent(object)}/relations`,
          { signal: this.controller.signal },
        ),
      );
      if (!this.current(generation)) return;
      if (result.source_id !== source || result.object_id !== object)
        throw new ApiError("关系目录来源不一致", 403);
      this.state.relations[JSON.stringify([source, object])] = result;
    } catch (error) {
      if (this.current(generation)) this.catalogFailure(error);
    }
  }
  async loadMetrics(): Promise<void> {
    const generation = this.generation;
    try {
      const result = editorMetricListSchema.parse(
        await this.dependencies.request("/api/metrics", { signal: this.controller.signal }),
      );
      if (this.current(generation)) this.state.metrics = result.items;
    } catch (error) {
      if (this.current(generation)) this.catalogFailure(error);
    }
  }
  async loadMetric(id: string, version?: number): Promise<void> {
    const generation = this.generation;
    try {
      const metric = metricDefinitionSchema.parse(
        await this.dependencies.request(
          `/api/metrics/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`,
          { signal: this.controller.signal },
        ),
      );
      if (this.current(generation))
        this.state.metrics = [
          ...this.state.metrics.filter(
            (m) => !(m.metric_id === id && m.version === metric.version),
          ),
          metric,
        ];
    } catch (error) {
      if (this.current(generation)) this.catalogFailure(error);
    }
  }
  async loadAgents(): Promise<void> {
    const generation = this.generation;
    try {
      const result = agentListSchema.parse(
        await this.dependencies.request("/api/agents", { signal: this.controller.signal }),
      );
      if (this.current(generation)) this.state.agents = result.items;
    } catch (error) {
      if (this.current(generation)) this.catalogFailure(error);
    }
  }
}
export { ReportEditor };
