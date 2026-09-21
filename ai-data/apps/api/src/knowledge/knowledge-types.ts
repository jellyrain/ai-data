import type { z } from "zod";
import type {
  KnowledgeCandidate,
  KnowledgeContent,
  MemorySource,
  MemoryScope,
  MetricDefinition,
  PublishedKnowledge,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type {
  knowledgeOperationSchema,
  knowledgeReviewRecordSchema,
  knowledgeSourceRecordSchema,
} from "./knowledge-records";
/** 保存来源所属账号及已校验引用。 */
type KnowledgeSourceRecord = z.infer<typeof knowledgeSourceRecordSchema>;
/** 单次审核和固定候选版本快照。 */
type KnowledgeReviewRecord = z.infer<typeof knowledgeReviewRecordSchema>;
/** 提交或回滚操作的幂等结果。 */
type KnowledgeOperation = z.infer<typeof knowledgeOperationSchema>;
/** 候选和发布的事务仓储；传入执行器时参与调用方现有事务。 */
interface KnowledgeRepository {
  transaction<T>(
    organizationId: string,
    operation: (executor: MetadataQueryExecutor) => Promise<T>,
    executor?: MetadataQueryExecutor,
  ): Promise<T>;
  isActiveUser(
    organizationId: string,
    userId: string,
    executor: MetadataQueryExecutor,
  ): Promise<boolean>;
  findCandidate(
    organizationId: string,
    id: string,
    executor?: MetadataQueryExecutor,
  ): Promise<KnowledgeCandidate | null>;
  findDuplicate(
    organizationId: string,
    hash: string,
    executor: MetadataQueryExecutor,
  ): Promise<KnowledgeCandidate | null>;
  listCandidates(organizationId: string, userId?: string): Promise<KnowledgeCandidate[]>;
  saveCandidate(candidate: KnowledgeCandidate, executor: MetadataQueryExecutor): Promise<void>;
  addSource(
    organizationId: string,
    id: string,
    userId: string,
    source: MemorySource,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
  listSources(
    organizationId: string,
    id: string,
    executor?: MetadataQueryExecutor,
  ): Promise<KnowledgeSourceRecord[]>;
  saveReview(review: KnowledgeReviewRecord, executor: MetadataQueryExecutor): Promise<void>;
  listReviews(
    organizationId: string,
    id: string,
    executor?: MetadataQueryExecutor,
  ): Promise<KnowledgeReviewRecord[]>;
  findOperation(
    organizationId: string,
    userId: string,
    key: string,
    executor: MetadataQueryExecutor,
  ): Promise<KnowledgeOperation | null>;
  saveOperation(
    organizationId: string,
    userId: string,
    key: string,
    operation: KnowledgeOperation,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
  listVersions(
    organizationId: string,
    id: string,
    executor?: MetadataQueryExecutor,
  ): Promise<PublishedKnowledge[]>;
  findVersion(
    organizationId: string,
    id: string,
    version: number,
    executor?: MetadataQueryExecutor,
  ): Promise<PublishedKnowledge | null>;
  findCandidatePublication(
    organizationId: string,
    candidateId: string,
    executor: MetadataQueryExecutor,
  ): Promise<PublishedKnowledge | null>;
  findPublished(
    organizationId: string,
    id: string,
    version: number | undefined,
    now: string,
    executor?: MetadataQueryExecutor,
  ): Promise<PublishedKnowledge | null>;
  listPublished(organizationId: string, now: string): Promise<PublishedKnowledge[]>;
  savePublished(record: PublishedKnowledge, executor: MetadataQueryExecutor): Promise<void>;
  setEnabled(
    organizationId: string,
    id: string,
    enabled: boolean,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
}
/** 当前权限校验需要沿调用链使用同一事务连接。 */
interface KnowledgeDependencies {
  /** 模板候选引用固定定义；提交检查维护权，读取与审核检查完整查询范围。 */
  templates?: {
    validate(
      context: AuthContext,
      content: Extract<KnowledgeContent, { type: "report_template" }>,
      executor?: MetadataQueryExecutor,
    ): Promise<void>;
    assertSubmit(
      context: AuthContext,
      content: Extract<KnowledgeContent, { type: "report_template" }>,
      executor?: MetadataQueryExecutor,
    ): Promise<void>;
  };
  repository: KnowledgeRepository;
  metrics: {
    validateDefinition(
      context: AuthContext,
      metric: MetricDefinition,
      executor?: MetadataQueryExecutor,
    ): Promise<void>;
  };
  authorizeScope(
    context: AuthContext,
    scope: MemoryScope,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  validateSource(
    context: AuthContext,
    source: MemorySource,
    executor?: MetadataQueryExecutor,
    sharedReference?: boolean,
  ): Promise<void>;
  now?: () => Date;
}
export type {
  KnowledgeRepository,
  KnowledgeSourceRecord,
  KnowledgeReviewRecord,
  KnowledgeOperation,
  KnowledgeDependencies,
};
