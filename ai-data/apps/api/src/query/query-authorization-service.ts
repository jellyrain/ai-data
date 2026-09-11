import {
  dataAccessQueryRequestSchema,
  isDataValue,
  type ApiDatasetConfig,
  type Dataset,
  type QueryAccessContext,
  type QueryDsl,
} from "@ai-data/contracts";
import dayjs from "dayjs";

import type { AuthContext } from "../auth/auth-types";
import type {
  BusinessCatalogService,
  AuthorizedDataset,
} from "../catalog/business-catalog-service";
import type { JwtService } from "../auth/jwt-service";

/** API 授权完成后交给 DAS Client 的查询载荷。 */
type AuthorizedQuery = {
  request: { access: QueryAccessContext; query: QueryDsl; signature: string };
  token: string;
};

/** 查询授权失败时使用的稳定错误。 */
class QueryAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code = "UNAUTHORIZED",
  ) {
    super(message);
    this.name = "QueryAuthorizationError";
  }
}

/** 校验查询 DSL、合并角色行策略并生成 DAS 所需的访问上下文。 */
class QueryAuthorizationService {
  constructor(
    private readonly catalog: BusinessCatalogService,
    private readonly jwt: JwtService,
    private readonly policyVersion = 1,
  ) {}

  /** 返回已完成目录、字段、Join、参数和行策略校验的内部查询载荷。 */
  async authorize(
    input: unknown,
    context: AuthContext,
    analysisRunId = crypto.randomUUID(),
  ): Promise<AuthorizedQuery> {
    const parsed = dataAccessQueryRequestSchema.shape.query.safeParse(input);
    if (!parsed.success) throw new QueryAuthorizationError("查询 DSL 格式无效", "INVALID_INPUT");
    const query = parsed.data;
    const datasets = await this.catalog.listAuthorized(context, query.source_id);
    const from = datasets.find((item) => item.dataset.object_id === query.from.object_id);
    if (!from) throw new QueryAuthorizationError("主数据对象无权访问", "UNAUTHORIZED_OBJECT");

    let authorizedQuery: QueryDsl;
    let outputMasks: QueryAccessContext["output_masks"] = [];
    if (query.type === "relational_query") {
      const relations = await this.resolveRelations(query, datasets, context);
      authorizedQuery = this.authorizeRelational(query, relations, from, context);
      outputMasks = this.buildOutputMasks(authorizedQuery, relations, context);
    } else {
      authorizedQuery = this.authorizeParameterized(query, from);
    }

    const access: QueryAccessContext = {
      user_id: context.userId,
      organization_id: context.organizationId,
      analysis_run_id: analysisRunId,
      policy_version: this.policyVersion,
      expires_at: dayjs().add(55, "second").format("YYYY-MM-DD HH:mm:ss"),
      output_masks: outputMasks,
    };
    const token = await this.jwt.signInternalQueryToken({
      userId: context.userId,
      organizationId: context.organizationId,
      analysisRunId,
      policyVersion: this.policyVersion,
    });
    return {
      request: {
        access,
        query: authorizedQuery,
        signature: this.jwt.signQueryRequest(access, authorizedQuery),
      },
      token,
    };
  }

  private async resolveRelations(
    query: Extract<QueryDsl, { type: "relational_query" }>,
    datasets: AuthorizedDataset[],
    context: AuthContext,
  ): Promise<Map<string, { authorized: AuthorizedDataset; config: ApiDatasetConfig | null }>> {
    const refs = [
      query.from,
      ...query.joins.map((join) => ({ object_id: join.object_id, alias: join.alias })),
    ];
    const result = new Map<
      string,
      { authorized: AuthorizedDataset; config: ApiDatasetConfig | null }
    >();
    for (const ref of refs) {
      if (result.has(ref.alias))
        throw new QueryAuthorizationError("查询别名不能重复", "INVALID_INPUT");
      const authorized = datasets.find((item) => item.dataset.object_id === ref.object_id);
      if (!authorized)
        throw new QueryAuthorizationError("Join 数据对象无权访问", "UNAUTHORIZED_OBJECT");
      result.set(ref.alias, {
        authorized,
        config: await this.catalog.getAuthorizedConfig(context, query.source_id, ref.object_id),
      });
    }
    return result;
  }

  private authorizeRelational(
    query: Extract<QueryDsl, { type: "relational_query" }>,
    relations: Map<string, { authorized: AuthorizedDataset; config: ApiDatasetConfig | null }>,
    from: AuthorizedDataset,
    context: AuthContext,
  ): Extract<QueryDsl, { type: "relational_query" }> {
    const fields = new Map<string, Dataset["columns"]>();
    for (const [alias, relation] of relations)
      fields.set(alias, relation.authorized.dataset.columns);
    const assertField = (
      reference: string,
    ): { alias: string; name: string; dataType: Dataset["columns"][number]["data_type"] } => {
      const [alias, name] = reference.split(".");
      const column =
        alias && name ? fields.get(alias)?.find((item) => item.name === name) : undefined;
      if (!alias || !name || !column)
        throw new QueryAuthorizationError(`字段无权访问: ${reference}`, "UNAUTHORIZED_COLUMN");
      return { alias, name, dataType: column.data_type };
    };
    for (const item of query.select) {
      assertField(item.field);
      const capability = relations.get(item.field.split(".")[0])?.authorized.dataset
        .query_capabilities;
      if (
        item.aggregation &&
        capability?.aggregations &&
        !capability.aggregations.some(
          (value) =>
            value.field === item.field.split(".")[1] && value.functions.includes(item.aggregation!),
        )
      )
        throw new QueryAuthorizationError(`字段不允许聚合: ${item.field}`, "UNSUPPORTED_QUERY");
    }
    for (const field of query.group_by) assertField(field);
    for (const item of query.order_by) assertField(item.field);
    validateFilterFields(query.filters, assertField);
    query.joins.forEach((join, index) => {
      const leftAlias = index === 0 ? query.from.alias : query.joins[index - 1].alias;
      const left = relations.get(leftAlias);
      const right = relations.get(join.alias);
      const allowed = left?.config?.approved_relations.find(
        (relation) => relation.target_object_id === join.object_id,
      );
      if (
        !allowed ||
        !join.on.every((condition) =>
          allowed.column_pairs.some(
            (pair) =>
              `${leftAlias}.${pair.source_column}` === condition.left &&
              `${join.alias}.${pair.target_column}` === condition.right,
          ),
        )
      )
        throw new QueryAuthorizationError("Join 未匹配已批准的业务关系", "UNAUTHORIZED_OBJECT");
      void right;
    });

    const mandatory = [
      ...context.dataPolicies.filter((policy) => policy.mandatory),
      ...[...relations.values()].flatMap((relation) =>
        relation.authorized.rowPolicies
          .filter(
            (policy) =>
              policy.condition.value !== undefined && ["eq", "in"].includes(policy.condition.op),
          )
          .map((policy) => ({
            resource: policy.object_id,
            field: policy.condition.field,
            operator: policy.condition.op as "eq" | "in",
            value: policy.condition.value!,
            mandatory: true as const,
          })),
      ),
    ];
    const injected = mandatory.map((policy) => {
      const alias =
        [...relations.entries()].find(
          ([, relation]) => relation.authorized.dataset.object_id === policy.resource,
        )?.[0] ?? query.from.alias;
      const field = assertField(`${alias}.${policy.field}`);
      const value = policy.value;
      const values = Array.isArray(value) ? value : [value];
      if (!values.every((item) => isDataValue(item, field.dataType)))
        throw new QueryAuthorizationError("行策略值类型无效", "POLICY_REJECTED");
      return {
        field: `${alias}.${policy.field}`,
        op: policy.operator,
        data_type: field.dataType,
        value,
      };
    });
    return {
      ...query,
      filters: injected.length
        ? { logic: "and", items: [query.filters, ...injected] }
        : query.filters,
    };
  }

  private authorizeParameterized(
    query: Extract<QueryDsl, { type: "parameterized_query" }>,
    authorized: AuthorizedDataset,
  ): Extract<QueryDsl, { type: "parameterized_query" }> {
    if (authorized.dataset.kind !== "stored_procedure" && authorized.dataset.kind !== "api_dataset")
      throw new QueryAuthorizationError("对象不支持参数化查询", "UNSUPPORTED_QUERY");
    const config = authorized.dataset.query_capabilities;
    void config;
    const definitions = new Map(
      authorized.dataset.query_parameters.map((parameter) => [parameter.name, parameter]),
    );
    for (const parameter of query.parameters) {
      const definition = definitions.get(parameter.name);
      if (
        !definition ||
        !isDataValue(parameter.value, definition.data_type) ||
        parameter.data_type !== definition.data_type
      )
        throw new QueryAuthorizationError(`查询参数无效: ${parameter.name}`, "INVALID_INPUT");
    }
    for (const definition of definitions.values())
      if (
        definition.required &&
        !query.parameters.some((parameter) => parameter.name === definition.name) &&
        definition.default_value === undefined
      )
        throw new QueryAuthorizationError(`缺少必填参数: ${definition.name}`, "INVALID_INPUT");
    return query;
  }

  private buildOutputMasks(
    query: Extract<QueryDsl, { type: "relational_query" }>,
    relations: Map<string, { authorized: AuthorizedDataset; config: ApiDatasetConfig | null }>,
    context: AuthContext,
  ): QueryAccessContext["output_masks"] {
    return query.select.flatMap((item) => {
      if (!item.field.includes(".")) return [];
      const [alias, field] = item.field.split(".");
      const policy = relations
        .get(alias)
        ?.config?.column_policies.find((candidate) => candidate.field === field);
      if (
        !policy ||
        policy.default_masking.type === "none" ||
        policy.unmasked_role_ids.some((roleId) => context.roleIds?.includes(roleId))
      )
        return [];
      return [
        { result_column: item.as ?? item.field.replaceAll(".", "_"), rule: policy.default_masking },
      ];
    });
  }
}

function validateFilterFields(
  group: Extract<QueryDsl, { type: "relational_query" }>["filters"],
  assertField: (field: string) => unknown,
): void {
  for (const item of group.items) {
    if ("items" in item) validateFilterFields(item, assertField);
    else assertField(item.field);
  }
}

export { QueryAuthorizationError, QueryAuthorizationService };
export type { AuthorizedQuery };
