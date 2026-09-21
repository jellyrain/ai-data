import type {
  QueryEvidence,
  ReportDefinition,
  ReportDefinitionVersion,
  ReusableReportBlock,
  SaveReportDefinitionInput,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";

/** 统一定义和可复用块使用相同的版本存储规则。 */
type DefinitionKind = "report" | "block";
/** 仓储返回的固定版本记录。 */
type DefinitionRecord = ReportDefinitionVersion | ReusableReportBlock;
/** 定义仓储在同一事务内锁定头记录并保存不可变版本。 */
interface DefinitionRepository {
  transaction<T>(
    operation: (executor: MetadataQueryExecutor) => Promise<T>,
    executor?: MetadataQueryExecutor,
  ): Promise<T>;
  find(
    kind: DefinitionKind,
    organizationId: string,
    id: string,
    version?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<DefinitionRecord | null>;
  save(
    kind: DefinitionKind,
    context: AuthContext,
    input: SaveReportDefinitionInput,
    id?: string,
    expectedVersion?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<DefinitionRecord>;
  list(
    kind: DefinitionKind,
    organizationId: string,
    after: string | undefined,
    limit: number,
  ): Promise<DefinitionRecord[]>;
  versions(kind: DefinitionKind, organizationId: string, id: string): Promise<DefinitionRecord[]>;
  assertActiveUsers(
    organizationId: string,
    users: string[],
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  source(
    context: AuthContext,
    runId: string,
    requireOwner: boolean,
    executor?: MetadataQueryExecutor,
    artifactId?: string,
  ): Promise<QueryEvidence[]>;
}
/** 查询校验只读取目录与权限；定义保存不会执行数据查询。 */
type DefinitionDependencies = {
  repository: DefinitionRepository;
  validateDefinition(
    context: AuthContext,
    definition: ReportDefinition,
    executor?: MetadataQueryExecutor,
  ): Promise<unknown>;
  authorizeEvidence(
    context: AuthContext,
    evidence: QueryEvidence,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  listPublished?: (
    context: AuthContext,
    executor?: MetadataQueryExecutor,
  ) => Promise<ReportDefinitionVersion[]>;
};
/** 游标按稳定业务标识推进，分页数量由服务边界校验。 */
type DefinitionListInput = { limit?: number; cursor?: string };
export type {
  DefinitionKind,
  DefinitionRecord,
  DefinitionRepository,
  DefinitionDependencies,
  DefinitionListInput,
};
