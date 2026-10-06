import {
  stableStringify,
  type KnowledgeManagementRecord,
  type KnowledgeOwnerOptionsInput,
  type KnowledgeCandidate,
  type MemorySource,
  type PublishedKnowledge,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type {
  KnowledgeOperation,
  KnowledgeRepository,
  KnowledgeReviewRecord,
  KnowledgeSourceRecord,
} from "../../src/knowledge/knowledge-types";
/** 以串行写操作模拟领域事务边界；SQL 锁及原子性另由集成测试验证。 */
class MemoryKnowledgeRepository implements KnowledgeRepository {
  candidates = new Map<string, KnowledgeCandidate>();
  sources = new Map<string, KnowledgeSourceRecord>();
  versions = new Map<string, PublishedKnowledge>();
  enabled = new Map<string, boolean>();
  reviews: KnowledgeReviewRecord[] = [];
  operations = new Map<string, KnowledgeOperation>();
  executor: MetadataQueryExecutor = { execute: async () => ({ rows: [], rowsAffected: [] }) };
  private pending: Promise<unknown> = Promise.resolve();
  transaction<T>(
    _org: string,
    work: (executor: MetadataQueryExecutor) => Promise<T>,
    external?: MetadataQueryExecutor,
  ): Promise<T> {
    if (external) return work(external);
    const result = this.pending.then(() => work(this.executor));
    this.pending = result.catch(() => {});
    return result;
  }
  async listManagement(
    org: string,
    now: string,
    ownerId?: string,
    id?: string,
  ): Promise<KnowledgeManagementRecord[]> {
    const result: KnowledgeManagementRecord[] = [];
    const ids = [
      ...new Set(
        [...this.versions.values()]
          .filter((record) => record.organization_id === org)
          .map((record) => record.knowledge_id),
      ),
    ].sort();
    for (const key of ids) {
      const latest = (await this.listVersions(org, key))[0]!;
      if ((id && key !== id) || (ownerId && latest.owner_id !== ownerId)) continue;
      result.push({
        knowledge_id: key,
        enabled: this.enabled.get(org + ":" + key) !== false,
        latest,
        current: await this.findPublished(org, key, undefined, now),
      });
    }
    return result.slice(0, 200);
  }
  async ownerOptions(org: string, input: KnowledgeOwnerOptionsInput) {
    return (org === "org" ? ["admin", "author", "owner"] : [])
      .filter((id) => id.includes(input.keyword))
      .slice(0, input.limit)
      .map((id) => ({ user_id: id, username: id, display_name: id }));
  }
  async isActiveUser(org: string, userId: string) {
    return org === "org" && ["admin", "author", "owner"].includes(userId);
  }
  async findCandidate(org: string, id: string) {
    return this.candidates.get(`${org}:${id}`) ?? null;
  }
  async findDuplicate(org: string, hash: string) {
    return (
      [...this.candidates.values()].find(
        (candidate) =>
          candidate.organization_id === org &&
          candidate.content_hash === hash &&
          candidate.status !== "withdrawn",
      ) ?? null
    );
  }
  async listCandidates(org: string, userId?: string) {
    return [...this.candidates.values()].filter(
      (candidate) =>
        candidate.organization_id === org &&
        (!userId || candidate.created_by === userId || candidate.owner_id === userId),
    );
  }
  async saveCandidate(candidate: KnowledgeCandidate) {
    this.candidates.set(
      `${candidate.organization_id}:${candidate.candidate_id}`,
      structuredClone(candidate),
    );
  }
  async addSource(org: string, id: string, userId: string, source: MemorySource) {
    this.sources.set(`${org}:${id}:${stableStringify({ userId, source })}`, {
      user_id: userId,
      source,
    });
  }
  async listSources(org: string, id: string) {
    return [...this.sources.entries()]
      .filter(([key]) => key.startsWith(`${org}:${id}:`))
      .map(([, value]) => value);
  }
  async saveReview(review: KnowledgeReviewRecord) {
    this.reviews.unshift(structuredClone(review));
  }
  async listReviews(org: string, id: string) {
    return this.reviews.filter(
      (review) => review.candidate.organization_id === org && review.candidate.candidate_id === id,
    );
  }
  async findOperation(org: string, userId: string, key: string) {
    return this.operations.get(`${org}:${userId}:${key}`) ?? null;
  }
  async saveOperation(org: string, userId: string, key: string, operation: KnowledgeOperation) {
    this.operations.set(`${org}:${userId}:${key}`, structuredClone(operation));
  }
  async listVersions(org: string, id: string) {
    return [...this.versions.values()]
      .filter((record) => record.organization_id === org && record.knowledge_id === id)
      .sort((a, b) => b.version - a.version);
  }
  async findVersion(org: string, id: string, version: number) {
    return this.versions.get(`${org}:${id}:${version}`) ?? null;
  }
  async findCandidatePublication(org: string, candidateId: string) {
    return (
      [...this.versions.values()].find(
        (record) =>
          record.organization_id === org &&
          record.source_candidate_id === candidateId &&
          !record.rollback_from_version,
      ) ?? null
    );
  }
  async findPublished(org: string, id: string, version: number | undefined, now: string) {
    return this.enabled.get(`${org}:${id}`) === false
      ? null
      : ((await this.listVersions(org, id)).find(
          (record) =>
            record.effective_at <= now && (version === undefined || record.version === version),
        ) ?? null);
  }
  async listPublished(org: string, now: string) {
    const result: PublishedKnowledge[] = [];
    for (const id of new Set(
      [...this.versions.values()]
        .filter((record) => record.organization_id === org)
        .map((record) => record.knowledge_id),
    )) {
      const record = await this.findPublished(org, id, undefined, now);
      if (record) result.push(record);
    }
    return result;
  }
  async savePublished(record: PublishedKnowledge) {
    this.versions.set(
      `${record.organization_id}:${record.knowledge_id}:${record.version}`,
      structuredClone(record),
    );
  }
  async setEnabled(org: string, id: string, enabled: boolean) {
    this.enabled.set(`${org}:${id}`, enabled);
  }
}
export { MemoryKnowledgeRepository };
