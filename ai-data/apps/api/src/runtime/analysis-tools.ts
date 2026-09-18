import { createHash } from "node:crypto";
import dayjs from "dayjs";
import { z } from "zod";
import { stableStringify, type RunLease } from "@ai-data/contracts";
import type { ApiCatalogService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { MetricService } from "../metrics/metric-service";
import type { ReportService } from "../reports/report-service";
import type { HarnessTool, HarnessToolResult } from "../harness/harness-types";
import type { SkillResources } from "../skills/skill-resources";
import { ApplicationError } from "../errors/application-error";
import { toolDescriptions, toolInputs } from "./tool-contracts";
import { modelQueryResult } from "./model-query-result";
import { modelToolSchema } from "./model-tool-schema";

/** 工具调用依赖服务层的授权、证据和报告能力。 */
type ToolDependencies = {
  skills?: Pick<SkillResources, "readReference">;
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
      .filter(([name]) => name !== "read_skill_reference" || this.dependencies.skills)
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
      const schema = toolInputs[name as keyof typeof toolInputs];
      if (!schema) throw new ApplicationError("INVALID_INPUT", "工具不存在");
      const parsed = schema.parse(input);
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
