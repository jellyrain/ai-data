// 默认入口只提供仓储依赖的抽象类型，SQL Server 实现从独立子入口导入。
export type {
  MetadataBatchExecutor,
  MetadataConnectionConfig,
  MetadataDatabaseHealthChecker,
  MetadataDatabaseStatus,
  MetadataMigration,
  MetadataParameter,
  MetadataParameterType,
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "./metadata-types";
export type { MetadataTransactionalExecutor } from "./metadata-types";
