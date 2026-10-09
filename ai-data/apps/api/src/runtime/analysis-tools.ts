import { createHash } from "node:crypto";
import dayjs from "dayjs";
import { z } from "zod";
import {
  stableStringify,
  type RunLease,
  type MemoryScope,
  type PublishedKnowledge,
  type QueryDsl,
} from "@ai-data/contracts";
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
import {
  toolDescriptions,
  toolInputs,
  toolArgumentsSchema,
  schemaOnDemandTools,
} from "./tool-contracts";
import { modelQueryResult } from "./model-query-result";
import { toolInputSummary, toolOutputSummary } from "./tool-presentation";
import { modelToolSchema } from "./model-tool-schema";
import { metricQueryRequirements } from "../metrics/metric-query-requirements";
import { datasetSummary, metricSummary, discoveryPage } from "./model-discovery-result";
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
    | "preferences"
    | "save"
    | "knowledge"
    | "stageCandidate"
    | "capture"
    | "captureMetric"
    | "businessRules"
    | "recordKnowledge"
  >;
  runs: Pick<AnalysisRunService, "assertCurrent" | "recordTool" | "query" | "clarify">;
  catalog: ApiCatalogService;
  metrics: Pick<MetricService, "list" | "get" | "query">;
  reports: Pick<ReportService, "save">;
  refreshContext: (context: AuthContext) => Promise<AuthContext>;
  listSourceIds: () => Promise<string[]>;
};

class AnalysisTools {
  private readonly readRules = new Set<string>();
  constructor(private readonly dependencies: ToolDependencies) {}

  private usesJsonArguments(name: string): boolean {
    return (
      this.dependencies.allowedNames?.includes("get_tool_schema") === true &&
      schemaOnDemandTools.has(name)
    );
  }

  definitions(): HarnessTool[] {
    return Object.entries(toolInputs)
      .filter(
        ([name]) => name !== "get_tool_schema" || this.dependencies.allowedNames?.includes(name),
      )
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
        description:
          toolDescriptions[name as keyof typeof toolInputs] +
          (this.usesJsonArguments(name)
            ? ` 先调用 get_tool_schema(tool_name="${name}") 读取完整参数，将业务参数对象序列化为 arguments_json 后调用本工具。`
            : ""),
        inputSchema: modelToolSchema(
          z.toJSONSchema(this.usesJsonArguments(name) ? toolArgumentsSchema : schema, {
            io: "input",
          }),
        ),
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
    const base = {
      tool_call_id: auditId,
      tool_name: name.slice(0, 128),
      input_hash: inputHash,
      input_summary: "参数未通过校验",
    };
    try {
      if (this.dependencies.allowedNames && !this.dependencies.allowedNames.includes(name))
        throw new ApplicationError("UNAUTHORIZED", "Agent 未启用该工具");
      const schema = toolInputs[name as keyof typeof toolInputs];
      if (!schema) throw new ApplicationError("INVALID_INPUT", "工具不存在");
      if (this.usesJsonArguments(name)) {
        const { arguments_json } = toolArgumentsSchema.parse(input);
        if (Buffer.byteLength(arguments_json, "utf8") > 65536)
          throw new ApplicationError("INVALID_INPUT", "arguments_json 超出 65536 字节上限");
        try {
          input = JSON.parse(arguments_json);
        } catch {
          throw new ApplicationError("INVALID_INPUT", "arguments_json 不是有效的 JSON 对象");
        }
      }
      const parsed = schema.parse(input);
      base.input_summary = toolInputSummary(name, parsed);
      await this.dependencies.runs.recordTool(context, runId, lease, {
        ...base,
        status: "running",
        duration_ms: 0,
      });
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
      // 只有通过容量与租约检查的正文才能记为已读取；失败返回不能放行下一次查询。
      if (output && typeof output === "object") {
        if (name === "get_published_knowledge" && "knowledge_id" in output)
          await this.rememberKnowledge(context, runId, lease, [output as PublishedKnowledge]);
        else if (
          ["describe_dataset", "describe_metric", "query_dataset", "query_metric"].includes(name) &&
          "business_rules" in output
        )
          await this.rememberKnowledge(
            context,
            runId,
            lease,
            output.business_rules as PublishedKnowledge[],
          );
      }
      await this.dependencies.runs.recordTool(context, runId, lease, {
        ...base,
        status: "completed",
        duration_ms: dayjs().diff(started),
        evidence_ids: evidenceIds(output),
        output_summary: toolOutputSummary(name, output),
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
      // 指标日期联合类型的默认错误只有 Invalid input，交付具体格式以便模型修正。
      const issues =
        error instanceof z.ZodError
          ? error.issues.slice(0, 10).map((issue) => ({
              path: issue.path.map(String).join(".").slice(0, 256),
              message:
                name === "query_metric" &&
                issue.code === "invalid_union" &&
                issue.path.length === 1 &&
                ["start", "end"].includes(String(issue.path[0]))
                  ? "必须使用有效的 YYYY-MM-DD 日期或 YYYY-MM-DD HH:mm:ss 日期时间（空格分隔，UTC+8），具体格式按 describe_metric.query_requirements.time_format 填写"
                  : issue.message.slice(0, 512),
            }))
          : undefined;
      const metricInputError = name === "query_metric" && Boolean(issues?.length);
      const message =
        error instanceof ApplicationError
          ? error.message
          : metricInputError
            ? issues!
                .map((issue) => `${issue.path || "参数"}：${issue.message}`)
                .join("；")
                .slice(0, 3900)
            : "工具调用失败，请检查业务条件";
      await this.dependencies.runs.recordTool(context, runId, lease, {
        ...base,
        status: "failed",
        duration_ms: dayjs().diff(started),
        error_code: code,
        output_summary:
          `${code}：${error instanceof ApplicationError || metricInputError ? message : error instanceof z.ZodError ? "调用参数格式无效" : "工具执行失败"}`.slice(
            0,
            4000,
          ),
      });
      return {
        success: false,
        output: {
          code,
          message,
          ...(issues ? { issues } : {}),
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
      case "get_tool_schema": {
        const { tool_name } = toolInputs.get_tool_schema.parse(input);
        if (!this.definitions().some((tool) => tool.name === tool_name))
          throw new ApplicationError("UNAUTHORIZED", "当前 Agent 不可读取该工具定义");
        const name = tool_name as keyof typeof toolInputs;
        return {
          name,
          description: toolDescriptions[name],
          input_schema: z.toJSONSchema(toolInputs[name], { io: "input" }),
        };
      }
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
        if (name === "get_user_preferences") return memory.preferences(context);
        if (name === "save_user_preference") return memory.save(context, runId, lease, input, key);
        if (name === "create_knowledge_candidate")
          return memory.stageCandidate(context, runId, lease, input, key);
        const request = toolInputs.get_published_knowledge.parse(input);
        const knowledge = await memory.knowledge(
          context,
          request.knowledge_id,
          request.version,
          request,
        );
        return knowledge;
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
        return { items: items.map((item) => datasetSummary(item.dataset)) };
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
          items: items.slice(offset, offset + request.limit).map(datasetSummary),
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
          business_rules: await this.rules(context, [
            { source_id: request.source_id, object_id: request.object_id },
          ]),
        };
      }
      case "list_metrics": {
        const request = toolInputs.list_metrics.parse(input);
        const items = (await this.dependencies.metrics.list(context)).filter(
          (item) => !request.source_id || item.query.source_id === request.source_id,
        );
        const page = discoveryPage(
          items,
          request,
          (item) => item.metric_id,
          (item) => `${item.name} ${item.description} ${item.aliases.join(" ")}`,
        );
        return { ...page, items: page.items.map(metricSummary) };
      }
      case "describe_metric": {
        const request = toolInputs.describe_metric.parse(input);
        const metric = await this.dependencies.metrics.get(
          context,
          request.metric_id,
          request.version,
        );
        return {
          ...metric,
          query_requirements: metricQueryRequirements(metric),
          business_rules: await this.rules(
            context,
            queryScopes(metric.query).map((scope) => ({ ...scope, metric_id: metric.metric_id })),
          ),
        };
      }
      case "query_dataset": {
        const query = toolInputs.query_dataset.parse(input).query;
        const unread = await this.unreadRules(context, runId, lease, queryScopes(query));
        if (unread.length)
          return {
            status: "rules_required",
            business_rules: unread,
            message: "请按上述正式规则确认或修正查询条件，再提交查询。",
          };
        const evidence = await this.dependencies.runs.query(
          context,
          runId,
          lease,
          key,
          query,
          undefined,
          { managed: true },
        );
        await this.dependencies.memory?.capture(context, runId, lease, evidence);
        return { ...modelQueryResult(evidence.result), evidence_id: evidence.evidence_id };
      }
      case "query_metric": {
        const { metric_id, ...request } = toolInputs.query_metric.parse(input);
        if (this.dependencies.memory) {
          const metric = await this.dependencies.metrics.get(context, metric_id, request.version);
          const unread = await this.unreadRules(
            context,
            runId,
            lease,
            queryScopes(metric.query).map((scope) => ({ ...scope, metric_id })),
          );
          if (unread.length)
            return {
              status: "rules_required",
              business_rules: unread,
              message: "请按上述正式规则确认指标和查询条件，再提交查询。",
            };
        }
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
  private ruleKey(runId: string, lease: RunLease, item: PublishedKnowledge) {
    return `${runId}:${lease.epoch}:${item.knowledge_id}:${item.version}`;
  }
  private async rememberKnowledge(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    knowledge: PublishedKnowledge[],
  ) {
    if (!knowledge.length) return;
    await this.dependencies.memory?.recordKnowledge(context, runId, lease, knowledge);
    for (const item of knowledge) this.readRules.add(this.ruleKey(runId, lease, item));
  }
  private async rules(context: AuthContext, scopes: MemoryScope[]) {
    return (await this.dependencies.memory?.businessRules(context, scopes)) ?? [];
  }
  private async unreadRules(
    context: AuthContext,
    runId: string,
    lease: RunLease,
    scopes: MemoryScope[],
  ) {
    const rules = ((await this.dependencies.memory?.businessRules(context, scopes)) ?? []).filter(
      (item) => !this.readRules.has(this.ruleKey(runId, lease, item)),
    );
    return rules;
  }
}
/** 查询涉及的对象范围用于补充适用业务规则，授权仍由查询服务执行。 */
function queryScopes(query: QueryDsl): MemoryScope[] {
  return [
    { source_id: query.source_id, object_id: query.from.object_id },
    ...(query.type === "relational_query"
      ? query.joins.map((join) => ({ source_id: query.source_id, object_id: join.object_id }))
      : []),
  ];
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
