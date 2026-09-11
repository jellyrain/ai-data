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
} from "../connectors/executable-query";
import type { DataSourceConfig, ExposedSourceObject } from "../metadata/metadata-records";

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
  /** 验签失败时抛出错误，成功后请求内容才可被 DAS 信任。 */
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
  alias: string;
  exposed: ExposedSourceObject;
  executable: ExecutableRelation;
};

type RelationalQueryRequest = DataAccessQueryRequest & {
  query: Extract<QueryDsl, { type: "relational_query" }>;
};
type ParameterizedQueryRequest = DataAccessQueryRequest & {
  query: Extract<QueryDsl, { type: "parameterized_query" }>;
};

/** 一次已验签、已映射的执行计划与结果出口策略。 */
type PlannedQuery = {
  query: ExecutableQuery;
  access: QueryAccessContext;
};

/** 将 API 已签名 DSL 映射为连接器可执行的本地物理查询。 */
class QueryPlanner {
  constructor(
    private readonly dataSourceLookup: EnabledDataSourceLookup,
    private readonly queryableObjectLookup: QueryableObjectLookup,
    private readonly signatureVerifier: QueryRequestSignatureVerifier,
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
    const joins = request.query.joins.map((join, index) => {
      const rightAlias = relations[index + 1].alias;
      for (const condition of join.on) {
        assertFieldReference(condition.left, aliases.slice(0, index + 1));
        assertFieldReference(condition.right, [rightAlias]);
      }
      return {
        type: join.type,
        relation: relations[index + 1].executable,
        on: join.on,
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
    assertUniqueIdentifiers(select.map((item) => item.as));
    const groupBy = request.query.group_by.map((field) => {
      assertFieldReference(field, aliases);
      return field;
    });
    const orderBy = request.query.order_by.map((item) => {
      assertFieldReference(item.field, aliases);
      return item;
    });

    return executableQuerySchema.parse({
      type: "relational_query",
      source_id: request.query.source_id,
      timeout_ms: sourceConfig.timeoutMs,
      row_limit: Math.min(request.query.limit ?? sourceConfig.rowLimit, sourceConfig.rowLimit),
      from: relations[0].executable,
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
    return executableQuerySchema.parse({
      type: "parameterized_query",
      source_id: request.query.source_id,
      timeout_ms: sourceConfig.timeoutMs,
      row_limit: Math.min(request.query.limit ?? sourceConfig.rowLimit, sourceConfig.rowLimit),
      from: relation.executable,
      parameters: request.query.parameters.map((parameter) => ({
        name: parameter.name,
        value: parameter.value,
        data_type: parameter.data_type,
      })),
    });
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

/** 校验字段引用只指向当前已声明的关系别名。 */
function assertFieldReference(field: string, aliases: string[]): void {
  if (!aliases.some((alias) => field.startsWith(`${alias}.`))) {
    throw new QueryPlanningError(`字段未引用已声明关系别名: ${field}`);
  }
}

/** 将 API 已校验的用户过滤转换为连接器最终过滤树。 */
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
