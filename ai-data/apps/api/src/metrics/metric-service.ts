import { createHash, randomUUID } from "node:crypto";
import {
  metricDefinitionSchema,
  metricExecutionInputSchema,
  stableStringify,
  type MetricDefinition,
  type MetricExecutionInput,
  type QueryEvidence,
  type QueryDsl,
  type RunLease,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { ApiQueryAuthorization } from "../app-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import { ApplicationError } from "../errors/application-error";
import { parseAnalysisQuery } from "../analysis-runs/analysis-query";
import type { MetricRepository } from "./metric-types";

/** 将固定时间依据和已发布维度写入 DSL，总计独立查询完整范围。 */
function buildMetricQueries(metric: MetricDefinition, input: MetricExecutionInput) {
  const length = metric.date_basis.data_type === "date" ? 10 : 19;
  if (
    input.start.length !== length ||
    input.end.length !== length ||
    new Set(input.dimensions).size !== input.dimensions.length ||
    input.dimensions.some((field) => !metric.dimensions.includes(field))
  )
    throw new ApplicationError("INVALID_INPUT", "指标时间类型或统计维度不符合定义");
  const filters = {
    logic: "and" as const,
    items: [
      metric.query.filters,
      {
        field: metric.date_basis.field,
        op: "between" as const,
        data_type: metric.date_basis.data_type,
        value: [input.start, input.end],
      },
    ],
  };
  const total = { ...metric.query, filters, group_by: [], order_by: [], limit: 1 };
  const grouped = {
    ...metric.query,
    filters,
    group_by: input.dimensions,
    select: [
      ...input.dimensions.map((field, index) => ({ field, as: `dimension_${index}` })),
      ...metric.query.select,
    ],
    order_by: input.dimensions.map((field) => ({ field, direction: "asc" as const })),
  };
  return { grouped, total };
}
/** 由已经过结果合同校验的聚合值计算比率，零分母明确表达为缺少可用值。 */
function calculateMetricValue(
  row: Record<string, unknown>,
  value: MetricDefinition["value"],
): number | null {
  const numeric = (column: string) => {
    const result = row[column];
    if (result === null) return null;
    if (typeof result !== "number" || !Number.isFinite(result))
      throw new ApplicationError("UNSUPPORTED_QUERY", "指标结果不是有效数值");
    return result;
  };
  if (value.type === "column") return numeric(value.column);
  const numerator = numeric(value.numerator),
    denominator = numeric(value.denominator);
  if (numerator === null || denominator === null || denominator === 0) return null;
  const result = numerator / denominator;
  if (!Number.isFinite(result))
    throw new ApplicationError("UNSUPPORTED_QUERY", "指标比率超出数值范围");
  return result;
}

class MetricService {
  constructor(
    private readonly repository: MetricRepository,
    private readonly authorization: ApiQueryAuthorization,
    private readonly runs: AnalysisRunService,
  ) {}

  /** 发布者维护指标口径；每个已声明维度和固定时间字段均经过当前目录校验。 */
  async publish(context: AuthContext, input: unknown): Promise<MetricDefinition> {
    if (!context.roles.includes("system_admin") && !context.permissions.includes("catalog:manage"))
      throw new ApplicationError("UNAUTHORIZED", "无指标管理权限");
    const metric = metricDefinitionSchema.parse(input);
    await this.validateDefinition(context, metric);
    await this.repository.publish(context.organizationId, metric);
    return metric;
  }
  private async validateDefinition(context: AuthContext, metric: MetricDefinition): Promise<void> {
    const range =
      metric.date_basis.data_type === "date"
        ? ["2026-01-01", "2026-12-31"]
        : ["2026-01-01 00:00:00", "2026-12-31 23:59:59"];
    for (const dimensions of [[], ...metric.dimensions.map((field) => [field])]) {
      const queries = buildMetricQueries(metric, {
        analysis_run_id: "definition-validation",
        idempotency_key: "definition-validation",
        start: range[0],
        end: range[1],
        dimensions,
      });
      await this.authorization.authorize(queries.grouped, context);
    }
  }
  async get(context: AuthContext, metricId: string, version?: number): Promise<MetricDefinition> {
    const metric = await this.repository.find(context.organizationId, metricId, version);
    if (!metric) throw new ApplicationError("NOT_FOUND", "指标不存在");
    await this.validateDefinition(context, metric);
    return metric;
  }
  async list(context: AuthContext): Promise<MetricDefinition[]> {
    const result: MetricDefinition[] = [];
    for (const metric of await this.repository.list(context.organizationId)) {
      try {
        result.push(await this.get(context, metric.metric_id, metric.version));
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          ![
            "UNAUTHORIZED_OBJECT",
            "UNAUTHORIZED_COLUMN",
            "POLICY_REJECTED",
            "UNAUTHORIZED",
          ].includes(error.code)
        )
          throw error;
      }
    }
    return result;
  }
  async execute(context: AuthContext, metricId: string, input: unknown, runLease?: RunLease) {
    const request = metricExecutionInputSchema.parse(input);
    const key = createHash("sha256").update(request.idempotency_key).digest("hex");
    const evidence = await this.runs.evidence(context, request.analysis_run_id);
    let grouped = evidence.find((item) => item.tool_call_id === key + "-groups");
    let total = evidence.find((item) => item.tool_call_id === key + "-total");
    const metric = await this.get(
      context,
      metricId,
      request.version ?? grouped?.metric?.version ?? total?.metric?.version,
    );
    const queries = buildMetricQueries(metric, request);
    const references = { metric_id: metric.metric_id, version: metric.version };
    const assertSame = (evidence: QueryEvidence, query: QueryDsl) => {
      if (
        stableStringify(parseAnalysisQuery(evidence.requested_query)) !==
          stableStringify(parseAnalysisQuery(query)) ||
        stableStringify(evidence.metric) !== stableStringify(references)
      )
        throw new ApplicationError("CONFLICT", "指标执行幂等键已用于其他内容");
    };
    if (grouped) assertSame(grouped, queries.grouped);
    if (total) assertSame(total, queries.total);
    const result = (groups: QueryEvidence, totals: QueryEvidence) => {
      if (totals.result.truncated || totals.result.rows.length !== 1)
        throw new ApplicationError("UNSUPPORTED_QUERY", "指标总计没有返回完整聚合结果");
      return {
        metric_id: metric.metric_id,
        version: metric.version,
        start: request.start,
        end: request.end,
        grouped: groups.result,
        values: groups.result.rows.map((row) => calculateMetricValue(row, metric.value)),
        total: calculateMetricValue(totals.result.rows[0], metric.value),
        evidence_ids: [groups.evidence_id, totals.evidence_id],
      };
    };
    if (
      !grouped ||
      !total ||
      (await this.runs.get(context, request.analysis_run_id)).status !== "completed"
    ) {
      const lease =
        runLease ?? (await this.runs.claim(context, request.analysis_run_id, randomUUID()));
      try {
        grouped = await this.runs.query(
          context,
          request.analysis_run_id,
          lease,
          key + "-groups",
          queries.grouped,
          references,
          { managed: Boolean(runLease) },
        );
        total = await this.runs.query(
          context,
          request.analysis_run_id,
          lease,
          key + "-total",
          queries.total,
          references,
          { managed: Boolean(runLease) },
        );
        const output = result(grouped, total);
        if (!runLease)
          await this.runs.complete(
            context,
            request.analysis_run_id,
            lease,
            `${metric.name}查询完成`,
          );
        return output;
      } catch (error) {
        if (!runLease) await this.runs.fail(context, request.analysis_run_id, lease, error);
        throw error;
      }
    }
    return result(grouped, total);
  }

  /** Agent 指标工具复用执行器租约，分组和总计完成后继续当前分析。 */
  async query(context: AuthContext, metricId: string, input: unknown, lease: RunLease) {
    const request = metricExecutionInputSchema.parse(input);
    await this.runs.assertCurrent(context, request.analysis_run_id, lease);
    return this.execute(context, metricId, request, lease);
  }
}
export { MetricService, buildMetricQueries, calculateMetricValue };
