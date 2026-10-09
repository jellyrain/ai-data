import { memoryIntentSchema, memoryEventSummarySchema } from "./memory/memory-event";
import type { MemoryIntent, MemoryEventSummary } from "./memory/memory-event-types";
import { memoryContextSchema } from "./memory/memory-context";
import type { MemoryContext } from "./memory/memory-context-types";
import { memoryScopeSchema, memorySourceSchema } from "./memory/memory-common";
import {
  preferenceTimeRangeSchema,
  userPreferenceValueSchema,
  userPreferenceInputSchema,
  userPreferenceSchema,
  saveUserPreferenceInputSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceResultSchema,
} from "./memory/user-preference";
import {
  knowledgeContentSchema,
  knowledgeCandidateInputSchema,
  knowledgeCandidateSchema,
  publishedKnowledgeSchema,
  knowledgeReviewInputSchema,
  knowledgePublishInputSchema,
} from "./knowledge/knowledge";
import type {
  MemoryScope,
  MemorySource,
  PreferenceTimeRange,
  UserPreferenceValue,
  UserPreferenceInput,
  UserPreference,
  SaveUserPreferenceInput,
  PreferenceConfirmation,
  SaveUserPreferenceResult,
} from "./memory/user-preference-types";
import type {
  KnowledgeContent,
  KnowledgeCandidateInput,
  KnowledgeCandidate,
  PublishedKnowledge,
  KnowledgeReviewInput,
  KnowledgePublishInput,
} from "./knowledge/knowledge-types";
import { columnOperationSchema } from "./permission/column-operation";
import {
  apiDatasetColumnDescriptionSchema,
  apiDatasetColumnPolicySchema,
  apiDatasetConfigSchema,
  approvedRelationSchema,
  queryParameterPolicySchema,
  queryPermissionBindingSchema,
  relationCardinalitySchema,
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
import {
  dataAccessSessionSchema,
  dataAccessHeartbeatAckSchema,
  dataAccessCredentialRequestSchema,
  dataAccessCredentialResponseSchema,
} from "./health/data-access-session";
import type {
  DataAccessSession,
  DataAccessCredentialRequest,
  DataAccessCredentialResponse,
} from "./health/data-access-session-types";
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
import { preAggregateSchema, preAggregateSelectSchema } from "./query/pre-aggregate";
import type { PreAggregate, PreAggregateSelect } from "./query/pre-aggregate-types";
import {
  columnPermissionSchema,
  rowConditionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "./permission/permission-policy";
import { sseEventSchema } from "./sse/sse-events";
import {
  queryResultColumnSchema,
  queryResultSchema,
  queryResultTableSchema,
} from "./query/query-result";
import { stableStringify } from "./query/request-signature";
import {
  dataAccessQueryRequestSchema,
  queryAccessContextSchema,
} from "./query/data-access-request";
import type { QueryAccessContext } from "./access/access-context-types";
import { maskingRuleSchema, outputMaskSchema } from "./query/output-mask";
import { base64Schema, dateSchema, dateTimeSchema, isDataValue } from "./shared/data-values";

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
  QueryPermissionBinding,
  RelationCardinality,
  RelationColumnPair,
} from "./catalog/api-dataset-types";
import type {
  QueryResult,
  QueryResultColumn,
  QueryResultDelivery,
} from "./query/query-result-types";
import type { QueryDsl } from "./query/query-dsl-types";
import type { DataAccessQueryRequest } from "./query/data-access-request-types";
import type {
  ColumnPermission,
  RowCondition,
  RowPolicy,
  TablePermission,
} from "./permission/permission-policy-types";
import type { SseEvent } from "./sse/sse-events-types";

import type { ColumnOperation } from "./permission/column-operation-types";
import type { MaskingRule } from "./query/output-mask-types";

// 统一出口：应用只从 @ai-data/contracts 引用，不直接依赖内部文件路径。
export {
  memoryContextSchema,
  memoryIntentSchema,
  memoryEventSummarySchema,
  memoryScopeSchema,
  memorySourceSchema,
  preferenceTimeRangeSchema,
  userPreferenceValueSchema,
  userPreferenceInputSchema,
  userPreferenceSchema,
  saveUserPreferenceInputSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceResultSchema,
  knowledgeContentSchema,
  knowledgeCandidateInputSchema,
  knowledgeCandidateSchema,
  publishedKnowledgeSchema,
  knowledgeReviewInputSchema,
  knowledgePublishInputSchema,
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
  queryResultTableSchema,
  queryResultSchema,
  stableStringify,
  dataAccessSessionSchema,
  dataAccessHeartbeatAckSchema,
  dataAccessCredentialRequestSchema,
  dataAccessCredentialResponseSchema,
  queryParameterSchema,
  queryParameterPolicySchema,
  queryPermissionBindingSchema,
  preAggregateSchema,
  preAggregateSelectSchema,
  filterConditionSchema,
  filterGroupSchema,
  relationColumnPairSchema,
  relationCardinalitySchema,
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
  MemoryContext,
  MemoryIntent,
  MemoryEventSummary,
  MemoryScope,
  MemorySource,
  PreferenceTimeRange,
  UserPreferenceValue,
  UserPreferenceInput,
  UserPreference,
  SaveUserPreferenceInput,
  PreferenceConfirmation,
  SaveUserPreferenceResult,
  KnowledgeContent,
  KnowledgeCandidateInput,
  KnowledgeCandidate,
  PublishedKnowledge,
  KnowledgeReviewInput,
  KnowledgePublishInput,
  DataAccessSession,
  DataAccessCredentialRequest,
  DataAccessCredentialResponse,
  ApiDatasetColumnDescription,
  ApiDatasetConfig,
  ApiDatasetColumnPolicy,
  ApprovedRelation,
  QueryParameterPolicy,
  QueryPermissionBinding,
  PreAggregate,
  PreAggregateSelect,
  RelationCardinality,
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
  QueryResultDelivery,
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
export {
  analysisRunStatusSchema,
  submitMessageSchema,
  clarificationSchema,
  clarificationAnswerSchema,
  runLeaseSchema,
  analysisRunSchema,
} from "./analysis-runs/analysis-run";
export type {
  AnalysisRunStatus,
  SubmitMessage,
  Clarification,
  ClarificationAnswer,
  RunLease,
  AnalysisRunState,
} from "./analysis-runs/analysis-run-types";
export {
  metricDefinitionSchema,
  metricExecutionInputSchema,
  metricValueSchema,
} from "./metrics/metric";
export type { MetricDefinition, MetricExecutionInput } from "./metrics/metric-types";
export { queryEvidenceSchema, analysisStepSchema } from "./evidence/evidence";
export type { QueryEvidence, AnalysisStep } from "./evidence/evidence-types";
export {
  reportBlockSchema,
  reportSectionSchema,
  saveReportInputSchema,
  savedReportSchema,
} from "./reports/report";
export type { SaveReportInput, SavedReport } from "./reports/report-types";
export { saveReportToolInputSchema, saveReportToolOutputSchema } from "./api-tools/api-tools";
export type { SaveReportToolInput, SaveReportToolOutput } from "./api-tools/api-tools-types";
export {
  MAX_QUERY_ROWS,
  MAX_QUERY_TABLE_BYTES,
  MAX_QUERY_RESPONSE_BYTES,
} from "./query/query-limits";
export { queryResultDeliverySchema } from "./query/query-result";
export {
  agentLimitsSchema,
  agentDefinitionSchema,
  agentVersionSchema,
  skillCatalogEntrySchema,
  agentToolEntrySchema,
  createConversationSchema,
} from "./agents/agent";
export type {
  AgentLimits,
  AgentDefinition,
  AgentVersion,
  SkillCatalogEntry,
  AgentToolEntry,
  CreateConversation,
} from "./agents/agent-types";
export {
  modelConfigurationInputSchema,
  modelConfigurationSchema,
} from "./agents/model-configuration";
export type {
  ModelConfigurationInput,
  ModelConfiguration,
} from "./agents/model-configuration-types";
export {
  publishedRelationInputSchema,
  catalogRelationSchema,
  relationPublishInputSchema,
  relationGraphSchema,
} from "./catalog/catalog-relations";
export type {
  PublishedRelationInput,
  CatalogRelation,
  RelationPublishInput,
  RelationGraph,
} from "./catalog/catalog-relations-types";
export {
  reportParameterValueSchema,
  reportParameterSchema,
  reportParameterBindingSchema,
  reportRelationalQuerySchema,
  reportMetricQuerySchema,
  reportQueryItemSchema,
  reportPresentationBlockSchema,
  reportDefinitionSchema,
  saveReportDefinitionInputSchema,
  reportDefinitionVersionSchema,
  reusableReportBlockSchema,
  reportRevisionInputSchema,
  reportRevisionBindingSchema,
} from "./reports/report-definition";
export type {
  ReportParameter,
  ReportParameterBinding,
  ReportQueryItem,
  ReportDefinition,
  SaveReportDefinitionInput,
  ReportDefinitionVersion,
  ReusableReportBlock,
  ReportRevisionInput,
  ReportRevisionBinding,
} from "./reports/report-definition-types";
export {
  reportExecutionInputSchema,
  reportExecutionResultSchema,
  reportExecutionSchema,
  reportNarrativeSchema,
  reportExecutionExportContentSchema,
} from "./reports/report-execution";
export type {
  ReportExecutionInput,
  ReportExecutionResult,
  ReportExecution,
  ReportNarrative,
  ReportExecutionExportContent,
} from "./reports/report-execution-types";
export {
  reportSharingInputSchema,
  analysisArtifactSchema,
  reportSummarySchema,
  reportListInputSchema,
  reportListSchema,
  exportEvidenceSchema,
  reportExportContentSchema,
  conversationExportContentSchema,
  reportVersionListSchema,
} from "./reports/report-management";
export type {
  AnalysisArtifact,
  ReportSummary,
  ReportListInput,
  ReportList,
  ReportExportContent,
  ConversationExportContent,
  ReportVersionList,
} from "./reports/report-management-types";
export { sourceListInputSchema, sourceListSchema } from "./catalog/source-list";
export {
  reportShareCandidateSchema,
  reportShareMemberSchema,
  reportSharingSchema,
  reportShareCandidatesInputSchema,
  reportShareCandidatesSchema,
} from "./reports/report-sharing";
export type {
  ReportShareCandidate,
  ReportShareMember,
  ReportSharing,
  ReportShareCandidatesInput,
  ReportShareCandidates,
} from "./reports/report-sharing-types";
export type { SourceListInput, SourceList } from "./catalog/source-list-types";
export {
  createManagedUserSchema,
  managedDepartmentsInputSchema,
  managedUserSchema,
  managedRoleSchema,
  managedDataScopeSchema,
  userAssignmentOptionsSchema,
  managedUserAuthorizationSchema,
} from "./admin/user-management";
export type {
  CreateManagedUser,
  ManagedDepartmentsInput,
  ManagedUser,
  ManagedRole,
  ManagedDataScope,
  UserAssignmentOptions,
  ManagedUserAuthorization,
} from "./admin/user-management-types";

export {
  currentPolicyStateSchema,
  adminDatasetDetailSchema,
  columnPermissionInputSchema,
  objectPermissionInputSchema,
  policyChangeSchema,
  policyListQuerySchema,
  policyParamsSchema,
  policySnapshotSchema,
  policyVersionParamsSchema,
  policyVersionSchema,
  policyVersionSummarySchema,
  queryPreviewInputSchema,
  rowPolicyInputSchema,
} from "./admin/catalog-management";

export {
  procedureDefinitionSchema,
  procedureOutputParameterSchema,
  postgresqlParameterTypeSchema,
} from "./data-access/procedure-definition";
export {
  managementRevisionSchema,
  deleteDataSourceSchema,
  dataSourceManagementConfigSchema,
  databaseTargetDiscoveryRequestSchema,
  sharedDatabaseCredentialsSchema,
  sourceObjectDiscoveryRequestSchema,
  sourceObjectSelectionRequestSchema,
  managedDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSourceObjectSchema,
  managedSourceObjectsSchema,
  managedSecretReferenceSchema,
  manageableSourceObjectSchema,
} from "./data-access/data-source-management";
export type {
  DataSourceManagementConfig,
  ManagedDataSource,
  ManagedDataSourceDetail,
  ManagedSourceObject,
  ManagedSourceObjects,
  ManagedSecretReference,
  ManageableSourceObject,
} from "./data-access/data-source-management-types";

export {
  managedDataAccessServiceSchema,
  databaseTargetSchema,
} from "./data-access/management-responses";
export type {
  ManagedDataAccessService,
  DatabaseTarget,
} from "./data-access/management-responses-types";

export type {
  AdminDatasetDetail,
  CurrentPolicyState,
  PolicyVersion,
  PolicyVersionSummary,
} from "./admin/catalog-management-types";
export {
  sqlServerTransportSchema,
  managedSqlServerTransportSchema,
  sqlServerTransportUpdateSchema,
} from "./data-access/sqlserver-transport";
export type {
  SqlServerTransport,
  ManagedSqlServerTransport,
  SqlServerTransportUpdate,
} from "./data-access/sqlserver-transport-types";

export {
  updateKnowledgeSchema,
  rollbackKnowledgeSchema,
  knowledgeSourceRecordSchema,
  knowledgeReviewRecordSchema,
  knowledgeManagementRecordSchema,
  knowledgeOwnerOptionsInputSchema,
  knowledgeOwnerOptionSchema,
} from "./knowledge/knowledge-management";
export type {
  UpdateKnowledge,
  RollbackKnowledge,
  KnowledgeSourceRecord,
  KnowledgeReviewRecord,
  KnowledgeManagementRecord,
  KnowledgeOwnerOptionsInput,
  KnowledgeOwnerOption,
} from "./knowledge/knowledge-management-types";
export { preferenceEditStateSchema } from "./memory/preference-management";
export type { PreferenceEditState } from "./memory/preference-management-types";
export {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  deleteDatabaseConnectionSchema,
  testDatabaseConnectionSchema,
  testDatabaseConnectionDraftSchema,
} from "./data-access/database-connection";
export type {
  DatabaseConnection,
  CreateDatabaseConnection,
  UpdateDatabaseConnection,
  TestDatabaseConnection,
} from "./data-access/database-connection-types";
