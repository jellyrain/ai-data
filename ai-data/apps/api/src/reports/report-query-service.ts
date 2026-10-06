import dayjs from "dayjs";
import {
  filterConditionSchema,
  isDataValue,
  reportDefinitionSchema,
  reportExecutionInputSchema,
  queryDslSchema,
  stableStringify,
  type filterGroupSchema,
  type ReportDefinition,
  type ReportParameter,
  type ReportQueryItem,
  type QueryDsl,
  type MetricDefinition,
} from "@ai-data/contracts";
import { createHash } from "node:crypto";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { buildMetricQueries } from "../metrics/metric-service";
import { resolvePreferenceTimeRange } from "../preferences/preference-time";
import { parseAnalysisQuery } from "../analysis-runs/analysis-query";
import type { BuiltReport, ReportQueryDependencies } from "./report-query-types";
import type { SavedReport } from "@ai-data/contracts";

/** 统一查询构建只做目录读取和授权；实际业务查询由公共执行器单独启动。 */
class ReportQueryService {
  constructor(private readonly dependencies: ReportQueryDependencies) {}

  async validate(
    context: AuthContext,
    input: ReportDefinition,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    await this.build(context, input, {}, { validation: true, executor });
  }

  /** 旧快照入口将原始请求转换为同一逻辑图，权限条件仍由执行时注入。 */
  async fromSnapshot(
    context: AuthContext,
    snapshot: SavedReport,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportDefinition> {
    const dependencies = executor ? this.dependencies.forExecutor?.(executor) : this.dependencies;
    if (!dependencies) throw new ApplicationError("INTERNAL_ERROR", "报表事务授权未配置");
    const queries: ReportDefinition["queries"] = [];
    const ids = new Map<string, string>();
    for (const [index, evidence] of snapshot.sources.entries()) {
      const queryId = `query_${index + 1}`;
      ids.set(evidence.evidence_id, queryId);
      const query = structuredClone(evidence.requested_query);
      if (evidence.metric) {
        const metric = await dependencies.metrics.get(
          context,
          evidence.metric.metric_id,
          evidence.metric.version,
        );
        queries.push({ query_id: queryId, query: restoreMetricQuery(metric, query), bindings: [] });
        continue;
      }
      if (query.type === "parameterized_query") {
        queries.push({ query_id: queryId, query, bindings: [] });
        continue;
      }
      const aliases = new Map([[query.from.alias, query.from.object_id]]);
      const joins: Extract<ReportQueryItem["query"], { type: "relational_query" }>["joins"] = [];
      for (const join of query.joins) {
        const { on, ...fields } = join;
        const candidates = [];
        for (const [alias, object] of aliases) {
          const config = await dependencies.catalog.getAuthorizedConfig(
            context,
            query.source_id,
            object,
          );
          for (const relation of config?.approved_relations ?? []) {
            const pairs = relation.column_pairs
              .map((pair) => `${alias}.${pair.source_column}=${join.alias}.${pair.target_column}`)
              .sort();
            const actual = on
              .map((pair) =>
                pair.left.startsWith(`${join.alias}.`)
                  ? `${pair.right}=${pair.left}`
                  : `${pair.left}=${pair.right}`,
              )
              .sort();
            if (
              relation.relation_id &&
              relation.target_object_id === join.object_id &&
              (!join.relation_id || relation.relation_id === join.relation_id) &&
              stableStringify(pairs) === stableStringify(actual)
            )
              candidates.push({ alias, relation });
          }
        }
        if (candidates.length !== 1)
          throw new ApplicationError("POLICY_REJECTED", "快照关系不能唯一映射到批准关系");
        joins.push({
          ...fields,
          relation_id: candidates[0].relation.relation_id!,
          source_alias: candidates[0].alias,
        });
        aliases.set(join.alias, join.object_id);
      }
      queries.push({ query_id: queryId, query: { ...query, joins }, bindings: [] });
    }
    const definition = reportDefinitionSchema.parse({
      title: snapshot.title,
      description: snapshot.description,
      queries,
      presentation: snapshot.sections.map((section) => ({
        ...section,
        blocks: section.blocks.flatMap((block) => {
          const { evidence_ids, ...presentation } = block;
          const queryIds = evidence_ids.map((id) => ids.get(id)!);
          if (block.type === "text")
            return [
              {
                ...presentation,
                query_ids: queryIds,
                source_execution_id:
                  snapshot.execution_id ??
                  createHash("sha256")
                    .update(`snapshot:${snapshot.report_id}:${snapshot.version}`)
                    .digest("hex"),
              },
            ];
          return queryIds.map((query_id, index) => ({
            ...presentation,
            block_id: queryIds.length === 1 ? block.block_id : `${block.block_id}_${index + 1}`,
            query_ids: [query_id],
          }));
        }),
      })),
    });
    await this.validate(context, definition, executor);
    return definition;
  }

  async build(
    context: AuthContext,
    input: ReportDefinition,
    inputValues: BuiltReport["parameters"],
    options: { validation?: boolean; executor?: MetadataQueryExecutor } = {},
  ): Promise<BuiltReport> {
    const definition = reportDefinitionSchema.parse(input);
    const dependencies = options.executor
      ? this.dependencies.forExecutor?.(options.executor)
      : this.dependencies;
    if (!dependencies) throw new ApplicationError("INTERNAL_ERROR", "报表事务授权未配置");
    const values = reportExecutionInputSchema.shape.parameters.parse(inputValues);
    if (Object.keys(values).some((name) => !definition.parameters.some((p) => p.name === name)))
      throw new ApplicationError("INVALID_INPUT", "包含未声明的报表参数");
    const parameters: BuiltReport["parameters"] = {};
    for (const parameter of definition.parameters) {
      let value = values[parameter.name] ?? parameter.default_value;
      if (values[parameter.name] === null) value = null;
      if (value === undefined && parameter.relative_time) {
        const range = resolvePreferenceTimeRange(
          parameter.relative_time.range,
          this.dependencies.now?.() ?? dayjs().valueOf(),
        );
        const start = range.start + (parameter.data_type === "datetime" ? " 00:00:00" : "");
        const end = range.end + (parameter.data_type === "datetime" ? " 23:59:59" : "");
        value =
          parameter.relative_time.part === "range"
            ? [start, end]
            : parameter.relative_time.part === "start"
              ? start
              : end;
      }
      if (value === undefined && options.validation) value = sampleParameter(parameter, definition);
      if (value === undefined) {
        if (parameter.required)
          throw new ApplicationError("INVALID_INPUT", `缺少报表参数：${parameter.name}`);
        continue;
      }
      validateParameter(parameter, value);
      parameters[parameter.name] = value;
    }
    const queries: BuiltReport["queries"] = [];
    const metrics = new Map<string, MetricDefinition>();
    for (const item of definition.queries) {
      const bound = structuredClone(item.query);
      let query: QueryDsl;
      let metric: MetricDefinition | undefined;
      if (bound.type === "metric_query") {
        for (const binding of item.bindings) {
          if (binding.target.type !== "metric_date")
            throw new ApplicationError(
              "INVALID_INPUT",
              "指标查询只能绑定日期，统计口径由指标定义固定",
            );
          const value = parameters[binding.parameter];
          if (value !== undefined) {
            if (typeof value !== "string")
              throw new ApplicationError("INVALID_INPUT", "指标日期必须为单个日期值");
            bound[binding.target.part] = value;
          }
        }
        if (bound.start > bound.end)
          throw new ApplicationError("INVALID_INPUT", "指标开始日期不能晚于结束日期");
        const key = `${bound.metric_id}:${bound.version ?? "latest"}`;
        metric =
          metrics.get(key) ??
          (await dependencies.metrics.get(context, bound.metric_id, bound.version));
        metrics.set(key, metric);
        query = buildMetricQueries(metric, {
          analysis_run_id: "report-build",
          idempotency_key: item.query_id,
          start: bound.start,
          end: bound.end,
          dimensions: bound.dimensions,
        })[bound.output];
      } else {
        query =
          bound.type === "parameterized_query"
            ? queryDslSchema.parse(bound)
            : await this.buildRelations(context, bound, dependencies);
        for (const binding of item.bindings) {
          const parameter = definition.parameters.find((p) => p.name === binding.parameter)!;
          const value = parameters[binding.parameter];
          if (binding.target.type === "metric_date")
            throw new ApplicationError("INVALID_INPUT", "该查询不是指标查询");
          if (binding.target.type === "parameter") {
            if (query.type !== "parameterized_query")
              throw new ApplicationError("INVALID_INPUT", "命名输入必须绑定参数化数据集");
            const name = binding.target.name;
            query.parameters = query.parameters.filter((p) => p.name !== name);
            if (value !== undefined)
              query.parameters.push({ name, data_type: parameter.data_type, value });
            continue;
          }
          if (query.type !== "relational_query")
            throw new ApplicationError("INVALID_INPUT", "固定输出数据集不能追加任意筛选字段");
          const target = binding.target;
          const condition =
            value === undefined
              ? undefined
              : filterConditionSchema.parse({
                  field: target.field,
                  op: target.op,
                  data_type: parameter.data_type,
                  value,
                });
          if (target.scope === "on") {
            const join = query.joins.find((join) => join.alias === target.alias);
            if (!join) throw new ApplicationError("INVALID_INPUT", "ON 条件必须绑定连接别名");
            join.on_filters = bindFilter(join.on_filters, target.field, target.op, condition);
          } else {
            const object =
              target.scope === "query"
                ? query
                : target.scope === "from"
                  ? query.from
                  : query.joins.find((join) => join.alias === target.alias);
            if (!object) throw new ApplicationError("INVALID_INPUT", "参数绑定的查询对象不存在");
            object.filters = bindFilter(object.filters, target.field, target.op, condition);
          }
        }
      }
      query = parseAnalysisQuery(query);
      const authorized = await dependencies.authorization.authorize(query, context);
      await this.validatePresentation(
        context,
        definition,
        item.query_id,
        authorized.request.query,
        dependencies,
      );
      queries.push({
        query_id: item.query_id,
        query,
        ...(metric ? { metric: { metric_id: metric.metric_id, version: metric.version } } : {}),
      });
    }
    return { parameters, queries };
  }

  private async buildRelations(
    context: AuthContext,
    query: Extract<ReportQueryItem["query"], { type: "relational_query" }>,
    dependencies: ReportQueryDependencies,
  ): Promise<QueryDsl> {
    const aliases = new Map([[query.from.alias, query.from.object_id]]);
    const joins = [];
    for (const edge of query.joins) {
      const source = aliases.get(edge.source_alias);
      if (!source || aliases.has(edge.alias))
        throw new ApplicationError("INVALID_INPUT", "关系方向、连接顺序或别名无效");
      const config = await dependencies.catalog.getAuthorizedConfig(
        context,
        query.source_id,
        source,
      );
      const relation = config?.approved_relations.find(
        (r) => r.relation_id === edge.relation_id && r.target_object_id === edge.object_id,
      );
      if (
        !relation ||
        !(relation.allowed_join_types ?? ["inner", "left", "right"]).includes(edge.type)
      )
        throw new ApplicationError("POLICY_REJECTED", "关系未发布、方向不符或连接方式未批准");
      const { source_alias, ...join } = edge;
      joins.push({
        ...join,
        on: relation.column_pairs.map((pair) => ({
          left: `${source_alias}.${pair.source_column}`,
          op: "eq" as const,
          right: `${edge.alias}.${pair.target_column}`,
        })),
      });
      aliases.set(edge.alias, edge.object_id);
    }
    return queryDslSchema.parse({ ...query, joins });
  }

  private async validatePresentation(
    context: AuthContext,
    definition: ReportDefinition,
    queryId: string,
    query: QueryDsl,
    dependencies: ReportQueryDependencies,
  ): Promise<void> {
    const columns = new Map<string, string>();
    if (query.type === "parameterized_query") {
      const dataset = await dependencies.catalog.getAuthorized(
        context,
        query.source_id,
        query.from.object_id,
      );
      for (const column of query.expected_output ?? dataset?.dataset.columns ?? [])
        columns.set(column.name, column.data_type);
    } else {
      const objects = [query.from, ...query.joins];
      for (const select of query.select) {
        const [alias, field] = select.field.split(".");
        const object = objects.find((o) => o.alias === alias);
        const dataset =
          object &&
          (await dependencies.catalog.getAuthorized(context, query.source_id, object.object_id));
        const aggregate = object?.pre_aggregate?.select.find((s) => s.as === field);
        const type =
          select.aggregation === "count" || select.aggregation === "count_distinct"
            ? "integer"
            : aggregate?.aggregation
              ? "decimal"
              : dataset?.dataset.columns.find((c) => c.name === field)?.data_type;
        if (type) columns.set(select.as ?? field, type);
      }
    }
    for (const block of definition.presentation
      .flatMap((s) => s.blocks)
      .filter((b) => b.query_ids.includes(queryId))) {
      if (block.columns?.some((name) => !columns.has(name)))
        throw new ApplicationError("INVALID_INPUT", "展示字段不属于查询输出");
      if (
        block.chart &&
        (!columns.has(block.chart.x) ||
          !["integer", "decimal"].includes(columns.get(block.chart.y) ?? ""))
      )
        throw new ApplicationError("INVALID_INPUT", "图表坐标不存在或数值轴不是数值字段");
    }
  }
}

/** 仅在已发布口径能精确重建历史请求时恢复指标引用，防止提取后丢失固定统计依据。 */
function restoreMetricQuery(
  metric: MetricDefinition,
  query: QueryDsl,
): Extract<ReportQueryItem["query"], { type: "metric_query" }> {
  if (query.type === "relational_query") {
    const conditions: ReturnType<typeof filterConditionSchema.parse>[] = [];
    const visit = (group: ReturnType<typeof filterGroupSchema.parse>) => {
      for (const item of group.items) {
        if ("items" in item) visit(item);
        else if (item.field === metric.date_basis.field && item.op === "between")
          conditions.push(item);
      }
    };
    visit(query.filters);
    for (const condition of conditions) {
      if (
        !Array.isArray(condition.value) ||
        condition.value.length !== 2 ||
        condition.value.some((value) => typeof value !== "string")
      )
        continue;
      const range = {
        start: String(condition.value[0]),
        end: String(condition.value[1]),
        dimensions: query.group_by,
      };
      const candidates = buildMetricQueries(metric, {
        ...range,
        analysis_run_id: "restore",
        idempotency_key: "restore",
      });
      for (const output of ["grouped", "total"] as const) {
        if (
          stableStringify(parseAnalysisQuery(candidates[output])) ===
          stableStringify(parseAnalysisQuery(query))
        )
          return {
            type: "metric_query",
            metric_id: metric.metric_id,
            version: metric.version,
            output,
            ...range,
          };
      }
    }
  }
  throw new ApplicationError("POLICY_REJECTED", "指标证据不能按已发布口径恢复");
}

/** 固定筛选改为参数时保留原来的布尔组；新增筛选在最外层采用 AND。 */
function bindFilter(
  group: ReturnType<typeof filterGroupSchema.parse> | undefined,
  field: string,
  op: string,
  condition: ReturnType<typeof filterConditionSchema.parse> | undefined,
): ReturnType<typeof filterGroupSchema.parse> {
  let found = false;
  const visit = (
    current: ReturnType<typeof filterGroupSchema.parse>,
  ): ReturnType<typeof filterGroupSchema.parse> => ({
    logic: current.logic,
    items: current.items.flatMap<ReturnType<typeof filterGroupSchema.parse>["items"][number]>(
      (item) => {
        if ("items" in item) {
          const nested = visit(item);
          return nested.items.length ? [nested] : [];
        }
        if (item.field !== field || item.op !== op) return [item];
        found = true;
        return condition ? [condition] : [];
      },
    ),
  });
  const result = visit(group ?? { logic: "and", items: [] });
  if (found || !condition) return result;
  return result.logic === "and"
    ? { ...result, items: [...result.items, condition] }
    : { logic: "and", items: [result, condition] };
}
/** 保存阶段用有界示例值复核字段权限，示例不会发送给 DAS 或保存为用户参数。 */
function sampleParameter(
  parameter: ReportParameter,
  definition: ReportDefinition,
): BuiltReport["parameters"][string] {
  const value =
    parameter.allowed_values?.[0] ??
    parameter.min ??
    parameter.max ??
    (parameter.data_type === "boolean"
      ? false
      : parameter.data_type === "integer" || parameter.data_type === "decimal"
        ? 0
        : parameter.data_type === "date"
          ? "2026-01-01"
          : parameter.data_type === "datetime"
            ? "2026-01-01 00:00:00"
            : parameter.data_type === "buffer"
              ? "AA=="
              : "validation");
  const targets = definition.queries
    .flatMap((q) => q.bindings)
    .filter((b) => b.parameter === parameter.name)
    .map((b) => b.target);
  return targets.some((t) => t.type === "filter" && t.op === "between")
    ? [value, value]
    : targets.some((t) => t.type === "filter" && ["in", "not_in"].includes(t.op))
      ? [value]
      : value;
}
/** 参数值不能突破定义类型、枚举或上下限；空值须由可选参数明确允许。 */
function validateParameter(
  parameter: ReportParameter,
  input: BuiltReport["parameters"][string],
): void {
  for (const value of Array.isArray(input) ? input : [input]) {
    if (
      !isDataValue(value, parameter.data_type) ||
      (value === null && parameter.required) ||
      (parameter.allowed_values &&
        !parameter.allowed_values.some(
          (allowed) => stableStringify(allowed) === stableStringify(value),
        )) ||
      (value !== null &&
        parameter.min !== undefined &&
        (typeof value !== typeof parameter.min || value < parameter.min)) ||
      (value !== null &&
        parameter.max !== undefined &&
        (typeof value !== typeof parameter.max || value > parameter.max))
    )
      throw new ApplicationError("INVALID_INPUT", `参数类型或取值范围无效：${parameter.name}`);
  }
}
export { ReportQueryService };
