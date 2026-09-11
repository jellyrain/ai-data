import { columnOperationSchema } from "./permission/column-operation";
import {
  apiDatasetColumnDescriptionSchema,
  apiDatasetColumnPolicySchema,
  apiDatasetConfigSchema,
  approvedRelationSchema,
  queryParameterPolicySchema,
  relationColumnPairSchema,
} from "./catalog/api-dataset";
import {
  aggregationCapabilitySchema,
  datasetColumnSchema,
  datasetSchema,
  dataTypeSchema,
  freshnessSchema,
  queryCapabilitiesSchema,
  queryConditionCapabilitySchema,
  queryParameterSchema,
  queryValueDefinitionSchema,
} from "./catalog/dataset";
import { dataAccessHeartbeatSchema, sourceHealthSchema } from "./health/health";
import { contractErrorCodeSchema, contractErrorSchema } from "./errors/errors";
import {
  describeDatasetInputSchema,
  describeDatasetOutputSchema,
  listDatasetsInputSchema,
  listDatasetsOutputSchema,
  queryDatasetInputSchema,
  queryDatasetOutputSchema,
  searchCatalogInputSchema,
  searchCatalogOutputSchema,
} from "./api-tools/api-tools";
import type {
  DescribeDatasetInput,
  DescribeDatasetOutput,
  ListDatasetsInput,
  ListDatasetsOutput,
  QueryDatasetInput,
  QueryDatasetOutput,
  SearchCatalogInput,
  SearchCatalogOutput,
} from "./api-tools/api-tools-types";
import {
  filterConditionSchema,
  filterGroupSchema,
  parameterizedQuerySchema,
  queryDslSchema,
  relationalQuerySchema,
} from "./query/query-dsl";
import { queryOperatorSchema } from "./query/query-operators";
import {
  columnPermissionSchema,
  rowConditionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "./permission/permission-policy";
import { sseEventSchema } from "./sse/sse-events";
import { queryResultColumnSchema, queryResultSchema } from "./query/query-result";
import { stableStringify } from "./query/request-signature";
import {
  dataAccessQueryRequestSchema,
  queryAccessContextSchema,
} from "./query/data-access-request";
import type { QueryAccessContext } from "./access/access-context-types";
import { maskingRuleSchema, outputMaskSchema } from "./query/output-mask";
import { base64Schema, dateSchema, dateTimeSchema, isDataValue } from "./shared/data-values";

import type { z } from "zod";
import type { DataAccessHeartbeat, SourceHealth } from "./health/health-types";
import type { ContractError, ContractErrorCode } from "./errors/error-types";
import type {
  Dataset,
  DatasetColumn,
  Freshness,
  QueryCapabilities,
  QueryConditionCapability,
  QueryParameter,
  QueryValueDefinition,
} from "./catalog/dataset-types";
import type {
  ApiDatasetColumnDescription,
  ApiDatasetColumnPolicy,
  ApiDatasetConfig,
  ApprovedRelation,
  QueryParameterPolicy,
  RelationColumnPair,
} from "./catalog/api-dataset-types";
import type { QueryResult, QueryResultColumn } from "./query/query-result-types";
import type { QueryDsl } from "./query/query-dsl-types";
import type { DataAccessQueryRequest } from "./query/data-access-request-types";
import type {
  ColumnPermission,
  RowCondition,
  RowPolicy,
  TablePermission,
} from "./permission/permission-policy-types";
import type { SseEvent } from "./sse/sse-events-types";

type ColumnOperation = z.infer<typeof columnOperationSchema>;
type MaskingRule = z.infer<typeof maskingRuleSchema>;

// 统一出口：应用只从 @ai-data/contracts 引用，不直接依赖内部文件路径。
export {
  aggregationCapabilitySchema,
  apiDatasetColumnDescriptionSchema,
  apiDatasetConfigSchema,
  apiDatasetColumnPolicySchema,
  approvedRelationSchema,
  columnOperationSchema,
  dateTimeSchema,
  dateSchema,
  base64Schema,
  isDataValue,
  columnPermissionSchema,
  dataAccessHeartbeatSchema,
  dataAccessQueryRequestSchema,
  queryAccessContextSchema,
  contractErrorCodeSchema,
  contractErrorSchema,
  datasetColumnSchema,
  datasetSchema,
  dataTypeSchema,
  describeDatasetInputSchema,
  describeDatasetOutputSchema,
  freshnessSchema,
  listDatasetsInputSchema,
  listDatasetsOutputSchema,
  maskingRuleSchema,
  outputMaskSchema,
  queryDslSchema,
  queryCapabilitiesSchema,
  queryConditionCapabilitySchema,
  queryOperatorSchema,
  queryValueDefinitionSchema,
  queryDatasetInputSchema,
  queryDatasetOutputSchema,
  parameterizedQuerySchema,
  queryResultColumnSchema,
  queryResultSchema,
  stableStringify,
  queryParameterSchema,
  queryParameterPolicySchema,
  filterConditionSchema,
  filterGroupSchema,
  relationColumnPairSchema,
  relationalQuerySchema,
  rowConditionSchema,
  rowPolicySchema,
  searchCatalogInputSchema,
  searchCatalogOutputSchema,
  sourceHealthSchema,
  sseEventSchema,
  tablePermissionSchema,
};

export type {
  ApiDatasetColumnDescription,
  ApiDatasetConfig,
  ApiDatasetColumnPolicy,
  ApprovedRelation,
  QueryParameterPolicy,
  RelationColumnPair,
  ColumnOperation,
  ColumnPermission,
  DataAccessHeartbeat,
  SourceHealth,
  ContractError,
  ContractErrorCode,
  QueryDsl,
  DataAccessQueryRequest,
  QueryAccessContext,
  QueryResult,
  QueryResultColumn,
  RowCondition,
  RowPolicy,
  SseEvent,
  TablePermission,
  Dataset,
  DatasetColumn,
  Freshness,
  QueryCapabilities,
  QueryConditionCapability,
  QueryParameter,
  QueryValueDefinition,
  DescribeDatasetInput,
  DescribeDatasetOutput,
  ListDatasetsInput,
  ListDatasetsOutput,
  MaskingRule,
  QueryDatasetInput,
  QueryDatasetOutput,
  SearchCatalogInput,
  SearchCatalogOutput,
};
