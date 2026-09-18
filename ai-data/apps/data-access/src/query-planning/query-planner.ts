import {
  dataAccessQueryRequestSchema,
  type DataAccessQueryRequest,
  type QueryDsl,
  type QueryAccessContext,
} from "@ai-data/contracts";

import {
  executableFilterGroupSchema,
  executableQuerySchema,
  type ExecutableFilterGroup,
  type ExecutableQuery,
  type ExecutableRelation,
  type ExecutableFilteredRelation,
} from "../connectors/executable-query";
import type { DataSourceConfig } from "../data-sources/data-source-types";
import type { ExposedSourceObject } from "../catalog/catalog-types";
import { procedureDefinitionSchema } from "../catalog/procedure-definition";
import { resolveParameters } from "../connectors/parameter-validator";
import { assertFixedOutput } from "../connectors/fixed-output-validator";
import type { ApiDatasetMappingLookup } from "../connectors/http-api-connector";
import { apiRequestParameterMappingSchema } from "../connectors/api-request-parameter-mapping";

/** 查询规划所需的本地对象白名单读取能力。 */
interface QueryableObjectLookup {
  /** 按逻辑对象读取可查询白名单及其物理映射。 */
  findQueryableBySourceIdAndObjectId(
    sourceId: string,
    objectId: string,
  ): Promise<ExposedSourceObject | undefined>;
}

/** 查询规划所需的已启用数据源配置读取能力。 */
interface EnabledDataSourceLookup {
  /** 读取指定数据源的运行限制。 */
  findEnabledBySourceId(sourceId: string): Promise<DataSourceConfig | undefined>;
}

/** 验证 API 对本次 access 和 query 生成的签名。 */
interface QueryRequestSignatureVerifier {
  /** 校验失败时抛错；调用方已完成验签时可注入空实现，必须保证该前置条件。 */
  verify(request: DataAccessQueryRequest): Promise<void>;
}

/** 请求无法映射为本地可执行查询时抛出的稳定错误。 */
class QueryPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryPlanningError";
  }
}

/** DAS 本地物理映射收敛后的一条关系。 */
type PlannedRelation = {
  /** DSL 使用的查询内别名。 */
  alias: string;
  /** 本地白名单中的业务标识与对象能力。 */
  exposed: ExposedSourceObject;
  /** 交给连接器的物理对象引用。 */
  executable: ExecutableRelation;
};

/** 判别为关系查询后保留完整审计上下文的请求类型。 */
type RelationalQueryRequest = DataAccessQueryRequest & {
  query: Extract<QueryDsl, { type: "relational_query" }>;
};
/** 判别为参数化查询后保留完整审计上下文的请求类型。 */
type ParameterizedQueryRequest = DataAccessQueryRequest & {
  query: Extract<QueryDsl, { type: "parameterized_query" }>;
};

/** 通过注入的校验器并完成本地映射的执行计划与结果策略。 */
type PlannedQuery = {
  /** 已映射物理对象并收紧资源上限的内部 DSL。 */
  query: ExecutableQuery;
  /** 原请求中的审计信息与结果脱敏指令。 */
  access: QueryAccessContext;
};

/** 将 API 已签名 DSL 映射为连接器可执行的本地物理查询。 */
class QueryPlanner {
  constructor(
    private readonly dataSourceLookup: EnabledDataSourceLookup,
    private readonly queryableObjectLookup: QueryableObjectLookup,
    private readonly signatureVerifier: QueryRequestSignatureVerifier,
    private readonly apiDatasetMappingLookup?: Pick<
      ApiDatasetMappingLookup,
      "findBySourceIdAndObjectId"
    >,
  ) {}

  /** 解析请求、读取本地映射并应用 DAS 自身的资源限制。 */
  async plan(input: unknown): Promise<PlannedQuery> {
    const request = dataAccessQueryRequestSchema.parse(input);
    await this.signatureVerifier.verify(request);
    const sourceConfig = await this.dataSourceLookup.findEnabledBySourceId(request.query.source_id);
    if (sourceConfig === undefined) {
      throw new QueryPlanningError(`数据源不可用: ${request.query.source_id}`);
    }

    if (request.query.type === "relational_query") {
      return {
        query: await this.planRelationalQuery(request as RelationalQueryRequest, sourceConfig),
        access: request.access,
      };
    }
    return {
      query: await this.planParameterizedQuery(request as ParameterizedQueryRequest, sourceConfig),
      access: request.access,
    };
  }

  /** 映射关系查询涉及的物理对象，并保留 API 已给出的查询语义。 */
  private async planRelationalQuery(
    request: RelationalQueryRequest,
    sourceConfig: DataSourceConfig,
  ): Promise<ExecutableQuery> {
    const relationInputs = [request.query.from, ...request.query.joins];
    assertUniqueIdentifiers(relationInputs.map((relation) => relation.alias));
    const relations = await Promise.all(
      relationInputs.map((relation) =>
        this.resolveRelation(request.query.source_id, relation.object_id, relation.alias),
      ),
    );
    for (const relation of relations) {
      if (relation.exposed.objectKind !== "table" && relation.exposed.objectKind !== "view") {
        throw new QueryPlanningError(`关系查询不能映射为表或视图: ${relation.exposed.objectId}`);
      }
    }

    const aliases = relations.map((relation) => relation.alias);
    const filteredRelations: ExecutableFilteredRelation[] = relations.map((relation, index) => ({
      ...relation.executable,
      ...(relationInputs[index].pre_aggregate === undefined
        ? {}
        : { pre_aggregate: relationInputs[index].pre_aggregate }),
      ...(relationInputs[index].filters === undefined
        ? {}
        : {
            filters: mapFilterGroup(relationInputs[index].filters, [relation.alias]),
          }),
    }));
    // 每次 Join 的左字段引用此前关系，右字段引用当前新加入的关系。
    const joins = request.query.joins.map((join, index) => {
      const rightAlias = relations[index + 1].alias;
      for (const condition of join.on) {
        assertFieldReference(condition.left, aliases.slice(0, index + 1));
        assertFieldReference(condition.right, [rightAlias]);
      }
      return {
        type: join.type,
        relation: filteredRelations[index + 1],
        on: join.on,
        ...(join.on_filters
          ? { on_filters: mapFilterGroup(join.on_filters, aliases.slice(0, index + 2)) }
          : {}),
      };
    });

    const filters = mapFilterGroup(request.query.filters, aliases);
    const select = request.query.select.map((item) => {
      assertFieldReference(item.field, aliases);
      return {
        field: item.field,
        ...(item.aggregation === undefined ? {} : { aggregation: item.aggregation }),
        as: item.as ?? item.field.replaceAll(".", "_"),
      };
    });
    // 默认别名由点号替换生成，仍需检测与显式别名或其他字段的碰撞。
    assertUniqueIdentifiers(select.map((item) => item.as));
    const groupBy = request.query.group_by.map((field) => {
      assertFieldReference(field, aliases);
      return field;
    });
    const orderBy = request.query.order_by.map((item) => {
      if (item.field.includes(".")) assertFieldReference(item.field, aliases);
      else if (!select.some((selection) => selection.as === item.field))
        throw new QueryPlanningError(`排序结果别名不存在: ${item.field}`);
      return item;
    });

    return executableQuerySchema.parse({
      type: "relational_query",
      source_id: request.query.source_id,
      timeout_ms: sourceConfig.timeoutMs,
      row_limit: Math.min(request.query.limit ?? sourceConfig.rowLimit, sourceConfig.rowLimit),
      from: filteredRelations[0],
      joins,
      filters,
      select,
      group_by: groupBy,
      order_by: orderBy,
    });
  }

  /** 映射 API 已校验完成的固定参数化调用。 */
  private async planParameterizedQuery(
    request: ParameterizedQueryRequest,
    sourceConfig: DataSourceConfig,
  ): Promise<ExecutableQuery> {
    if (sourceConfig.connectorKind === "http_api") {
      return this.planHttpApiQuery(request, sourceConfig);
    }
    const relation = await this.resolveRelation(
      request.query.source_id,
      request.query.from.object_id,
      request.query.from.alias,
    );
    if (
      relation.exposed.objectKind !== "stored_procedure" &&
      relation.exposed.objectKind !== "api_dataset"
    ) {
      throw new QueryPlanningError(
        `参数化查询不能映射为固定调用对象: ${relation.exposed.objectId}`,
      );
    }

    const parameterNames = request.query.parameters.map((parameter) => parameter.name);
    assertUniqueIdentifiers(parameterNames);
    let parameters = request.query.parameters;
    let definition;
    if (relation.exposed.objectKind === "stored_procedure") {
      if (!relation.exposed.procedureDefinition)
        throw new QueryPlanningError("存储过程缺少完整输入输出定义");
      if (sourceConfig.connectorKind === "oracle")
        throw new QueryPlanningError("Oracle 存储过程的原生结果集调用尚未支持");
      definition = procedureDefinitionSchema.parse(relation.exposed.procedureDefinition);
      if (
        sourceConfig.connectorKind === "postgresql" &&
        definition.query_parameters.length > 0 &&
        definition.postgresql_parameter_types === undefined
      ) {
        throw new QueryPlanningError("PostgreSQL 过程需要配置完整原生参数类型");
      }
      try {
        assertFixedOutput(request.query.expected_output, definition.columns);
      } catch (error) {
        throw new QueryPlanningError(error instanceof Error ? error.message : "固定输出校验失败");
      }
      if (sourceConfig.connectorKind !== "postgresql" && definition.output_parameters?.length) {
        throw new QueryPlanningError("当前数据库不支持 OUT 参数调用定义");
      }
      try {
        parameters = resolveParameters(definition.query_parameters, request.query.parameters);
      } catch (error) {
        throw new QueryPlanningError(error instanceof Error ? error.message : "过程参数校验失败");
      }
      // 位置调用必须显式补足每个输入；SQL Server 命名参数可交由数据库使用省略参数的默认值。
      if (
        sourceConfig.connectorKind !== "sqlserver" &&
        parameters.length !== definition.query_parameters.length
      ) {
        throw new QueryPlanningError("位置调用的可选参数必须配置显式默认值");
      }
    }
    return executableQuerySchema.parse({
      type: "parameterized_query",
      source_id: request.query.source_id,
      timeout_ms: sourceConfig.timeoutMs,
      row_limit: Math.min(request.query.limit ?? sourceConfig.rowLimit, sourceConfig.rowLimit),
      from: relation.executable,
      parameters: parameters.map((parameter) => ({
        name: parameter.name,
        value: parameter.value,
        data_type: parameter.data_type,
      })),
      ...(definition === undefined
        ? {}
        : {
            fixed_output: definition.columns,
            procedure_output_parameters: definition.output_parameters,
            procedure_parameter_types: definition.postgresql_parameter_types,
          }),
    });
  }

  /** HTTP 虚拟表映射本身构成 DAS 本地白名单，规划时核对 API 签名的完整输出与可信参数。 */
  private async planHttpApiQuery(
    request: ParameterizedQueryRequest,
    sourceConfig: DataSourceConfig,
  ): Promise<ExecutableQuery> {
    const mapping = await this.apiDatasetMappingLookup?.findBySourceIdAndObjectId(
      request.query.source_id,
      request.query.from.object_id,
    );
    if (
      !mapping ||
      mapping.sourceId !== request.query.source_id ||
      mapping.objectId !== request.query.from.object_id
    ) {
      throw new QueryPlanningError("HTTP API 虚拟表未配置为可查询");
    }
    const columns = mapping.response.fields.map((field) => ({
      name: field.name,
      data_type: field.dataType,
      nullable: field.nullable,
    }));
    try {
      assertFixedOutput(request.query.expected_output, columns);
      const definitions = mapping.request.parameterMappings.map((input) => {
        const parameter = apiRequestParameterMappingSchema.parse(input);
        return {
          name: parameter.name,
          allowed_ops: ["eq" as const],
          data_type: parameter.dataType,
          required: parameter.required,
          ...(parameter.defaultValue === undefined
            ? {}
            : { default_value: parameter.defaultValue }),
        };
      });
      return executableQuerySchema.parse({
        type: "parameterized_query",
        source_id: request.query.source_id,
        timeout_ms: sourceConfig.timeoutMs,
        row_limit: Math.min(request.query.limit ?? sourceConfig.rowLimit, sourceConfig.rowLimit),
        from: {
          object_id: mapping.objectId,
          native_object_name: mapping.objectId,
          alias: request.query.from.alias,
        },
        parameters: resolveParameters(definitions, request.query.parameters),
        fixed_output: columns,
      });
    } catch (error) {
      throw new QueryPlanningError(
        error instanceof Error ? error.message : "HTTP 固定调用定义校验失败",
      );
    }
  }

  /** 将逻辑对象与 DAS 本地白名单映射为物理关系。 */
  private async resolveRelation(
    sourceId: string,
    objectId: string,
    alias: string,
  ): Promise<PlannedRelation> {
    const exposed = await this.queryableObjectLookup.findQueryableBySourceIdAndObjectId(
      sourceId,
      objectId,
    );
    if (exposed === undefined || exposed.nativeObjectName === undefined) {
      throw new QueryPlanningError(`对象未配置为可查询: ${objectId}`);
    }

    return {
      alias,
      exposed,
      executable: {
        object_id: objectId,
        ...(exposed.nativeSchemaName === undefined
          ? {}
          : { native_schema_name: exposed.nativeSchemaName }),
        native_object_name: exposed.nativeObjectName,
        alias,
      },
    };
  }
}

/** 拒绝关系别名、结果列别名或参数名重复。 */
function assertUniqueIdentifiers(identifiers: string[]): void {
  if (new Set(identifiers).size !== identifiers.length) {
    throw new QueryPlanningError("查询标识不能重复");
  }
}

/** 检查字段引用是否具有已声明别名前缀；字段存在性属于目录校验职责。 */
function assertFieldReference(field: string, aliases: string[]): void {
  const segments = field.split(".");
  if (segments.length !== 2 || !segments[1] || !aliases.includes(segments[0])) {
    throw new QueryPlanningError(`字段未引用已声明关系别名: ${field}`);
  }
}

/** 递归保留查询级 AND/OR 结构，并检查每条条件的关系别名前缀。 */
function mapFilterGroup(
  input: Extract<QueryDsl, { type: "relational_query" }>["filters"],
  aliases: string[],
): ExecutableFilterGroup {
  const items = input.items.map((item) => {
    if ("items" in item) return mapFilterGroup(item, aliases);
    assertFieldReference(item.field, aliases);
    return {
      field: item.field,
      op: item.op,
      data_type: item.data_type,
      ...(item.value === undefined ? {} : { value: item.value }),
    };
  });
  return executableFilterGroupSchema.parse({ logic: input.logic, items });
}

export { QueryPlanner, QueryPlanningError };
export type {
  EnabledDataSourceLookup,
  PlannedQuery,
  QueryableObjectLookup,
  QueryRequestSignatureVerifier,
};
