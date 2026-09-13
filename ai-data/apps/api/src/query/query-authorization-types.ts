import type { ApiDatasetConfig, Dataset, QueryAccessContext, QueryDsl } from "@ai-data/contracts";

import type { AuthorizedDataset } from "../catalog/business-catalog-service";

/** 关系查询的授权转换输入与输出。 */
type RelationalQuery = Extract<QueryDsl, { type: "relational_query" }>;
/** 固定输出数据集的命名标量参数调用。 */
type ParameterizedQuery = Extract<QueryDsl, { type: "parameterized_query" }>;

/** 对象预过滤和查询级过滤使用相同的递归条件组。 */
type QueryFilterGroup = RelationalQuery["filters"];

/** 一个实际参与查询的对象别名及其授权目录、业务关系配置。 */
type QueryRelation = {
  authorized: AuthorizedDataset;
  config: ApiDatasetConfig | null;
};

/** 查询某一作用域内的可见字段，持续保留来源以实施授权和脱敏。 */
type AuthorizedField = {
  alias: string;
  sourceName: string;
  dataType: Dataset["columns"][number]["data_type"];
  /** 内层聚合函数；省略表示仍能一一对应原始字段。 */
  inputAggregation?: RelationalQuery["select"][number]["aggregation"];
};

/** 原始作用域和预聚合投影作用域分别维护，防止外层重新访问未投影列。 */
type RelationScopes = {
  rawFields: Map<string, AuthorizedField>;
  fields: Map<string, AuthorizedField>;
  uniqueKeys: Map<string, string[][]>;
};

/** 按加入顺序匹配到的批准关联，记录当前执行字段和配置证据。 */
type AuthorizedJoin = {
  sourceAlias: string;
  targetAlias: string;
  sourceFields: string[];
  targetFields: string[];
  relation: ApiDatasetConfig["approved_relations"][number];
};

/** API 查询转换后交给 DAS 客户端的签名载荷和内部认证令牌。 */
type AuthorizedQuery = {
  /** 访问上下文与最终 DSL 一同签名，DAS 对整体请求验签。 */
  request: { access: QueryAccessContext; query: QueryDsl; signature: string };
  /** 仅用于调用 DAS 的短时 JWT。 */
  token: string;
};

export type {
  AuthorizedQuery,
  AuthorizedField,
  AuthorizedJoin,
  ParameterizedQuery,
  QueryFilterGroup,
  QueryRelation,
  RelationScopes,
  RelationalQuery,
};
