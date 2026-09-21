import { createHash } from "node:crypto";
import dayjs from "dayjs";
import { z } from "zod";
import { stableStringify, type RunLease } from "@ai-data/contracts";
import type { ApiCatalogService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { MetricService } from "../metrics/metric-service";
import type { ReportService } from "../reports/report-service";
import type { ReportRevisionService } from "../reports/report-revision-service";
import type { ReportExecutionService } from "../reports/report-execution-service";
import type { HarnessTool, HarnessToolResult } from "../harness/harness-types";
import type { SkillResources } from "../skills/skill-resources";
import { ApplicationError } from "../errors/application-error";
import { toolDescriptions, toolInputs } from "./tool-contracts";
import { modelQueryResult } from "./model-query-result";
import { modelToolSchema } from "./model-tool-schema";
import type { MemoryRuntime } from "../memory/memory-runtime";
import { saveUserPreferenceResultSchema } from "@ai-data/contracts";

const memoryTools = new Set([
  "get_user_preferences",
  "save_user_preference",
  "get_published_knowledge",
  "create_knowledge_candidate",
]);

/** 工具调用依赖服务层的授权、证据和报告能力。 */
type ToolDependencies = {
  reportEditing?: Pick<ReportRevisionService, "read" | "stage" | "target">;
  reportExecutions?: Pick<ReportExecutionService, "get">;
  /** 省略用于既有通用接入；配置 Agent 时显式传入允许工具，空数组表示全部不开放。 */
  allowedNames?: readonly string[];
  skills?: Pick<SkillResources, "readReference">;
  memory?: Pick<
    MemoryRuntime,
    "snapshot" | "save" | "knowledge" | "stageCandidate" | "capture" | "captureMetric"
  >;
  runs: Pick<AnalysisRunService, "assertCurrent" | "recordTool" | "query" | "clarify">;
  catalog: ApiCatalogService;
  metrics: Pick<MetricService, "list" | "get" | "query">;
  reports: Pick<ReportService, "save">;
  refreshContext: (context: AuthContext) => Promise<AuthContext>;
  listSourceIds: () => Promise<string[]>;
};

class AnalysisTools {
  constructor(private readonly dependencies: ToolDependencies) {}

  definitions(): HarnessTool[] {
    return Object.entries(toolInputs)
      .filter(
        ([name]) =>
          !["get_report_definition", "save_report_definition"].includes(name) ||
          this.dependencies.reportEditing,
      )
      .filter(([name]) => name !== "get_report_execution" || this.dependencies.reportExecutions)
      .filter(([name]) => name !== "read_skill_reference" || this.dependencies.skills)
      .filter(([name]) => !memoryTools.has(name) || this.dependencies.memory)
      .filter(
        ([name]) =>
          this.dependencies.allowedNames === undefined ||
          this.dependencies.allowedNames.includes(name),
      )
      .map(([name, schema]) => ({
        name,
        description: toolDescriptions[name as keyof typeof toolInputs],
        inputSchema: modelToolSchema(z.toJSONSchema(schema, { io: "input" })),
      }));
  }

  /** 工具参数通过严格合同校验，当前身份及租约在调用和交付前分别复核。 */
  async execute(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    name: string,
    input: unknown,
    callId: string,
  ): Promise<HarnessToolResult> {
    context = await this.dependencies.refreshContext(context);
    await this.dependencies.runs.assertCurrent(context, runId, lease);
    const started = dayjs();
    const auditId = createHash("sha256").update(`${lease.epoch}:${callId}`).digest("hex");
    const inputHash = createHash("sha256").update(stableStringify(input)).digest("hex");
    const base = { tool_call_id: auditId, tool_name: name.slice(0, 128), input_hash: inputHash };
    await this.dependencies.runs.recordTool(context, runId, lease, {
      ...base,
      status: "running",
      duration_ms: 0,
    });
    try {
      if (this.dependencies.allowedNames && !this.dependencies.allowedNames.includes(name))
        throw new ApplicationError("UNAUTHORIZED", "Agent 未启用该工具");
      const schema = toolInputs[name as keyof typeof toolInputs];
      if (!schema) throw new ApplicationError("INVALID_INPUT", "工具不存在");
      const parsed = schema.parse(input);
      const reportTarget = await this.dependencies.reportEditing?.target(context, runId);
      if (reportTarget?.mode === "narrative") {
        if (
          !["get_report_execution", "read_skill_reference", "request_clarification"].includes(name)
        )
          throw new ApplicationError("UNAUTHORIZED", "分析说明只能引用绑定的报表执行结果");
        if (
          name === "get_report_execution" &&
          toolInputs.get_report_execution.parse(parsed).execution_id !== reportTarget.execution_id
        )
          throw new ApplicationError("UNAUTHORIZED", "分析说明不能切换来源执行");
      }
      const stableId = createHash("sha256")
        .update(name + stableStringify(parsed))
        .digest("hex");
      if (name === "request_clarification") {
        await this.dependencies.runs.clarify(
          context,
          runId,
          lease,
          { ...toolInputs.request_clarification.parse(parsed), clarification_id: stableId },
          { ...base, status: "completed", duration_ms: dayjs().diff(started) },
        );
        return { success: true, output: { clarification_id: stableId }, stop: true };
      }
      const output = await this.invoke(context, runId, lease, name, parsed, stableId);
      if (name === "save_user_preference") {
        const saved = saveUserPreferenceResultSchema.parse(output);
        if (saved.status === "confirmation_required") {
          const confirmation = saved.confirmation;
          await this.dependencies.runs.clarify(
            context,
            runId,
            lease,
            {
              clarification_id: confirmation.confirmation_id,
              preference_confirmation_id: confirmation.confirmation_id,
              question: `是否将账号偏好「${confirmation.proposed.key}」更新为：${JSON.stringify(confirmation.proposed.value)}，自动应用：${confirmation.proposed.auto_apply ? "开启" : "关闭"}？`,
              options: [
                { id: "approve", label: "同意更新此偏好" },
                { id: "reject", label: "保留当前设置" },
              ],
              allow_custom_input: false,
            },
            { ...base, status: "completed", duration_ms: dayjs().diff(started) },
          );
          return { success: true, output, stop: true };
        }
      }
      context = await this.dependencies.refreshContext(context);
      await this.dependencies.runs.assertCurrent(context, runId, lease);
      if (Buffer.byteLength(JSON.stringify(output), "utf8") > 65536)
        throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "工具返回内容超出分析容量");
      await this.dependencies.runs.recordTool(context, runId, lease, {
        ...base,
        status: "completed",
        duration_ms: dayjs().diff(started),
        evidence_ids: evidenceIds(output),
      });
      return { success: true, output };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        ["AUTHENTICATION_FAILED", "CANCELLED", "CONFLICT"].includes(error.code)
      )
        throw error;
      const code =
        error instanceof z.ZodError
          ? "INVALID_INPUT"
          : error instanceof ApplicationError
            ? error.code
            : "INTERNAL_ERROR";
      await this.dependencies.runs.recordTool(context, runId, lease, {
        ...base,
        status: "failed",
        duration_ms: dayjs().diff(started),
        error_code: code,
      });
      return {
        success: false,
        output: {
          code,
          message:
            error instanceof ApplicationError ? error.message : "工具调用失败，请检查业务条件",
          ...(error instanceof z.ZodError
            ? {
                issues: error.issues.slice(0, 10).map((issue) => ({
                  path: issue.path.map(String).join(".").slice(0, 256),
                  message: issue.message.slice(0, 512),
                })),
              }
            : {}),
        },
      };
    }
  }

  private async invoke(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    name: string,
    input: unknown,
    key: string,
  ): Promise<unknown> {
    switch (name) {
      case "get_report_definition": {
        if (!this.dependencies.reportEditing)
          throw new ApplicationError("NOT_FOUND", "报表编辑未启用");
        return this.dependencies.reportEditing.read(
          context,
          runId,
          toolInputs.get_report_definition.parse(input).report_id,
        );
      }
      case "save_report_definition": {
        if (!this.dependencies.reportEditing)
          throw new ApplicationError("NOT_FOUND", "报表编辑未启用");
        return this.dependencies.reportEditing.stage(context, runId, lease, input);
      }
      case "get_report_execution": {
        if (!this.dependencies.reportExecutions)
          throw new ApplicationError("NOT_FOUND", "报表执行未启用");
        const result = await this.dependencies.reportExecutions.get(
          context,
          toolInputs.get_report_execution.parse(input).execution_id,
        );
        return {
          execution_id: result.execution_id,
          status: result.status,
          definition_version: result.definition_version,
          parameters: result.parameters,
          results: result.results.map((item) => ({
            query_id: item.query_id,
            evidence_id: item.evidence.evidence_id,
            result: modelQueryResult(item.evidence.result),
          })),
        };
      }
      case "get_user_preferences":
      case "save_user_preference":
      case "get_published_knowledge":
      case "create_knowledge_candidate": {
        const memory = this.dependencies.memory;
        if (!memory) throw new ApplicationError("NOT_FOUND", "当前运行未启用记忆服务");
        if (name === "get_user_preferences") return memory.snapshot(context);
        if (name === "save_user_preference") return memory.save(context, runId, lease, input, key);
        if (name === "create_knowledge_candidate")
          return memory.stageCandidate(context, runId, lease, input, key);
        const request = toolInputs.get_published_knowledge.parse(input);
        return memory.knowledge(context, request.knowledge_id, request.version);
      }
      case "read_skill_reference": {
        const request = toolInputs.read_skill_reference.parse(input);
        if (!this.dependencies.skills)
          throw new ApplicationError("NOT_FOUND", "当前运行未加载 Skill");
        return this.dependencies.skills.readReference(request.skill_name, request.relative_path);
      }
      case "list_sources": {
        const items = [];
        for (const source_id of [...new Set(await this.dependencies.listSourceIds())]) {
          if ((await this.dependencies.catalog.listAuthorized(context, source_id)).length)
            items.push({ source_id });
          if (items.length >= 100) break;
        }
        return { items };
      }
      case "search_catalog": {
        const request = toolInputs.search_catalog.parse(input);
        const items = await this.dependencies.catalog.searchAuthorized(
          context,
          request.source_id,
          request.query,
          request.limit,
        );
        return { items: items.map((item) => item.dataset) };
      }
      case "list_datasets": {
        const request = toolInputs.list_datasets.parse(input);
        const offset =
          request.cursor === undefined
            ? 0
            : z
                .string()
                .regex(/^\d+$/)
                .transform(Number)
                .pipe(z.number().int().min(0).max(1000000))
                .parse(request.cursor);
        const items = (await this.dependencies.catalog.listAuthorized(context, request.source_id))
          .map((item) => item.dataset)
          .sort((a, b) => a.object_id.localeCompare(b.object_id));
        return {
          items: items.slice(offset, offset + request.limit),
          ...(offset + request.limit < items.length
            ? { next_cursor: String(offset + request.limit) }
            : {}),
        };
      }
      case "describe_dataset": {
        const request = toolInputs.describe_dataset.parse(input);
        const found = await this.dependencies.catalog.getAuthorized(
          context,
          request.source_id,
          request.object_id,
        );
        if (!found) throw new ApplicationError("NOT_FOUND", "数据集不存在或无权限访问");
        const config = await this.dependencies.catalog.getAuthorizedConfig(
          context,
          request.source_id,
          request.object_id,
        );
        const columns = new Set(found.dataset.columns.map((column) => column.name));
        const relations = [];
        for (const relation of config?.approved_relations ?? []) {
          const target = await this.dependencies.catalog.getAuthorized(
            context,
            request.source_id,
            relation.target_object_id,
          );
          if (
            target &&
            relation.column_pairs.every(
              (pair) =>
                columns.has(pair.source_column) &&
                target.dataset.columns.some((column) => column.name === pair.target_column),
            )
          )
            relations.push(relation);
        }
        return {
          dataset: found.dataset,
          grain: config?.grain,
          unique_keys: config?.unique_keys?.filter((key) =>
            key.every((field) => columns.has(field)),
          ),
          approved_relations: relations,
        };
      }
      case "list_metrics":
        return { items: await this.dependencies.metrics.list(context) };
      case "describe_metric": {
        const request = toolInputs.describe_metric.parse(input);
        return this.dependencies.metrics.get(context, request.metric_id, request.version);
      }
      case "query_dataset": {
        const evidence = await this.dependencies.runs.query(
          context,
          runId,
          lease,
          key,
          toolInputs.query_dataset.parse(input).query,
          undefined,
          { managed: true },
        );
        await this.dependencies.memory?.capture(context, runId, lease, evidence);
        return { ...modelQueryResult(evidence.result), evidence_id: evidence.evidence_id };
      }
      case "query_metric": {
        const { metric_id, ...request } = toolInputs.query_metric.parse(input);
        const result = await this.dependencies.metrics.query(
          context,
          metric_id,
          { ...request, analysis_run_id: runId, idempotency_key: key },
          lease,
        );
        const grouped = modelQueryResult(result.grouped);
        await this.dependencies.memory?.captureMetric(context, runId, lease, result.evidence_ids);
        return { ...result, grouped, values: result.values.slice(0, grouped.rows.length) };
      }
      case "save_report": {
        const request = toolInputs.save_report.parse(input);
        const report = await this.dependencies.reports.save(
          context,
          { ...request, analysis_run_id: runId, shared_with: [] },
          undefined,
          undefined,
          { lease, key },
        );
        return { report_id: report.report_id, version: report.version, title: report.title };
      }
      default:
        throw new ApplicationError("INVALID_INPUT", "工具不存在");
    }
  }
}
/** 查询工具直接返回证据标识，目录和报告工具返回空集合。 */
function evidenceIds(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  if ("evidence_id" in output && typeof output.evidence_id === "string")
    return [output.evidence_id];
  if ("evidence_ids" in output && Array.isArray(output.evidence_ids))
    return output.evidence_ids.filter((id): id is string => typeof id === "string");
  return [];
}
export { AnalysisTools };
