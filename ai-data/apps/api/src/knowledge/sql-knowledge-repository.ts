import { createHash } from "node:crypto";
import {
  knowledgeCandidateSchema,
  publishedKnowledgeSchema,
  stableStringify,
  type KnowledgeCandidate,
  type MemorySource,
  type PublishedKnowledge,
} from "@ai-data/contracts";
import type {
  MetadataParameter,
  MetadataQueryExecutor,
  MetadataTransactionalExecutor,
} from "@ai-data/metadata";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { ApplicationError } from "../errors/application-error";
import { SqlMetricRepository } from "../metrics/sql-metric-repository";
import {
  knowledgeOperationSchema,
  knowledgeReviewRecordSchema,
  knowledgeSourceRecordSchema,
} from "./knowledge-records";
import type {
  KnowledgeOperation,
  KnowledgeRepository,
  KnowledgeReviewRecord,
  KnowledgeSourceRecord,
} from "./knowledge-types";

/** 所有查询按组织限定，列表限量；写操作共享组织级事务锁保护去重与版本序列。 */
class SqlKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async transaction<T>(
    org: string,
    operation: (executor: MetadataQueryExecutor) => Promise<T>,
    external?: MetadataQueryExecutor,
  ): Promise<T> {
    const work = async (executor: MetadataQueryExecutor) => {
      const result = await executor.execute({
        sql: "DECLARE @result INT; EXEC @result=sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000; SELECT @result AS lock_result",
        parameters: [
          {
            name: "resource",
            type: "string",
            value: `knowledge:${createHash("sha256").update(org).digest("hex")}`,
          },
        ],
      });
      if (Number(result.rows[0]?.lock_result ?? -999) < 0)
        throw new ApplicationError("CONFLICT", "知识正在更新，请重试");
      return operation(executor);
    };
    return external ? work(external) : this.database.transaction(work);
  }
  private parameters(org: string, id?: string): MetadataParameter[] {
    return [
      { name: "org", type: "string", value: org },
      ...(id === undefined ? [] : [{ name: "id", type: "string" as const, value: id }]),
    ];
  }
  async isActiveUser(
    org: string,
    userId: string,
    executor: MetadataQueryExecutor,
  ): Promise<boolean> {
    const rows = await executor.execute({
      sql: "SELECT id FROM dbo.users WHERE organization_id=@org AND id=@id AND status='active'",
      parameters: this.parameters(org, userId),
    });
    return rows.rows.length === 1;
  }
  async findCandidate(
    org: string,
    id: string,
    executor = this.database,
  ): Promise<KnowledgeCandidate | null> {
    const result = await executor.execute({
      sql: "SELECT record_json FROM dbo.knowledge_candidates WHERE organization_id=@org AND candidate_id=@id",
      parameters: this.parameters(org, id),
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          knowledgeCandidateSchema.parse(JSON.parse(String(result.rows[0].record_json))),
        )
      : null;
  }
  async findDuplicate(
    org: string,
    hash: string,
    executor: MetadataQueryExecutor,
  ): Promise<KnowledgeCandidate | null> {
    const result = await executor.execute({
      sql: "SELECT TOP (1) record_json FROM dbo.knowledge_candidates WHERE organization_id=@org AND content_hash=@id AND JSON_VALUE(record_json,'$.status')<>'withdrawn' ORDER BY candidate_id",
      parameters: this.parameters(org, hash),
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          knowledgeCandidateSchema.parse(JSON.parse(String(result.rows[0].record_json))),
        )
      : null;
  }
  async listCandidates(org: string, userId?: string): Promise<KnowledgeCandidate[]> {
    const result = await this.database.execute({
      sql: "SELECT TOP (200) c.record_json FROM dbo.knowledge_candidates c WHERE c.organization_id=@org AND (@user IS NULL OR JSON_VALUE(c.record_json,'$.created_by')=@user OR JSON_VALUE(c.record_json,'$.owner_id')=@user OR EXISTS(SELECT 1 FROM dbo.knowledge_sources s WHERE s.organization_id=c.organization_id AND s.candidate_id=c.candidate_id AND s.user_id=@user)) ORDER BY JSON_VALUE(c.record_json,'$.updated_at') DESC,c.candidate_id",
      parameters: [
        ...this.parameters(org),
        { name: "user", type: "string", value: userId ?? null },
      ],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() => knowledgeCandidateSchema.parse(JSON.parse(String(row.record_json)))),
    );
  }
  async saveCandidate(input: KnowledgeCandidate, executor: MetadataQueryExecutor): Promise<void> {
    const candidate = knowledgeCandidateSchema.parse(input);
    await executor.execute({
      sql: "UPDATE dbo.knowledge_candidates SET version=@version,content_hash=@hash,record_json=@json WHERE organization_id=@org AND candidate_id=@id; IF @@ROWCOUNT=0 INSERT INTO dbo.knowledge_candidates(organization_id,candidate_id,version,content_hash,record_json) VALUES(@org,@id,@version,@hash,@json)",
      parameters: [
        ...this.parameters(candidate.organization_id, candidate.candidate_id),
        { name: "version", type: "integer", value: candidate.version },
        { name: "hash", type: "string", value: candidate.content_hash },
        { name: "json", type: "string", value: JSON.stringify(candidate) },
      ],
    });
  }
  async addSource(
    org: string,
    id: string,
    userId: string,
    source: MemorySource,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    const record = knowledgeSourceRecordSchema.parse({ user_id: userId, source });
    const hash = createHash("sha256").update(stableStringify(record)).digest("hex");
    const existing = await executor.execute({
      sql: "SELECT TOP (201) source_hash FROM dbo.knowledge_sources WHERE organization_id=@org AND candidate_id=@id ORDER BY source_hash",
      parameters: this.parameters(org, id),
    });
    if (existing.rows.some((row) => row.source_hash === hash)) return;
    if (existing.rows.length >= 200)
      throw new ApplicationError("POLICY_REJECTED", "候选最多保存 200 条来源支持");
    await executor.execute({
      sql: "IF NOT EXISTS(SELECT 1 FROM dbo.knowledge_sources WHERE organization_id=@org AND candidate_id=@id AND source_hash=@hash) INSERT INTO dbo.knowledge_sources(organization_id,candidate_id,source_hash,user_id,source_json) VALUES(@org,@id,@hash,@user,@json)",
      parameters: [
        ...this.parameters(org, id),
        { name: "hash", type: "string", value: hash },
        { name: "user", type: "string", value: userId },
        { name: "json", type: "string", value: JSON.stringify(record.source) },
      ],
    });
  }
  async listSources(
    org: string,
    id: string,
    executor = this.database,
  ): Promise<KnowledgeSourceRecord[]> {
    const result = await executor.execute({
      sql: "SELECT TOP (201) user_id,source_json FROM dbo.knowledge_sources WHERE organization_id=@org AND candidate_id=@id ORDER BY source_hash",
      parameters: this.parameters(org, id),
    });
    if (result.rows.length > 200)
      throw new ApplicationError("POLICY_REJECTED", "知识来源数量超出可验证范围");
    return result.rows.map((row) =>
      parseStoredRecord(() =>
        knowledgeSourceRecordSchema.parse({
          user_id: row.user_id,
          source: JSON.parse(String(row.source_json)),
        }),
      ),
    );
  }
  async saveReview(review: KnowledgeReviewRecord, executor: MetadataQueryExecutor): Promise<void> {
    const record = knowledgeReviewRecordSchema.parse(review);
    await executor.execute({
      sql: "INSERT INTO dbo.knowledge_reviews(organization_id,candidate_id,review_id,record_json) VALUES(@org,@id,@review,@json)",
      parameters: [
        ...this.parameters(record.candidate.organization_id, record.candidate.candidate_id),
        { name: "review", type: "string", value: record.review_id },
        { name: "json", type: "string", value: JSON.stringify(record) },
      ],
    });
  }
  async listReviews(
    org: string,
    id: string,
    executor = this.database,
  ): Promise<KnowledgeReviewRecord[]> {
    const result = await executor.execute({
      sql: "SELECT TOP (200) record_json FROM dbo.knowledge_reviews WHERE organization_id=@org AND candidate_id=@id ORDER BY JSON_VALUE(record_json,'$.reviewed_at') DESC,review_id DESC",
      parameters: this.parameters(org, id),
    });
    return result.rows.map((row) =>
      parseStoredRecord(() =>
        knowledgeReviewRecordSchema.parse(JSON.parse(String(row.record_json))),
      ),
    );
  }
  async findOperation(
    org: string,
    userId: string,
    key: string,
    executor: MetadataQueryExecutor,
  ): Promise<KnowledgeOperation | null> {
    const result = await executor.execute({
      sql: "SELECT request_hash,result_json FROM dbo.knowledge_operations WHERE organization_id=@org AND user_id=@user AND idempotency_key=@id",
      parameters: [...this.parameters(org, key), { name: "user", type: "string", value: userId }],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          knowledgeOperationSchema.parse({
            request_hash: result.rows[0].request_hash,
            result: JSON.parse(String(result.rows[0].result_json)),
          }),
        )
      : null;
  }
  async saveOperation(
    org: string,
    userId: string,
    key: string,
    input: KnowledgeOperation,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    const record = knowledgeOperationSchema.parse(input);
    await executor.execute({
      sql: "INSERT INTO dbo.knowledge_operations(organization_id,user_id,idempotency_key,request_hash,result_json) VALUES(@org,@user,@id,@hash,@json)",
      parameters: [
        ...this.parameters(org, key),
        { name: "user", type: "string", value: userId },
        { name: "hash", type: "string", value: record.request_hash },
        { name: "json", type: "string", value: JSON.stringify(record.result) },
      ],
    });
  }
  async listVersions(
    org: string,
    id: string,
    executor = this.database,
  ): Promise<PublishedKnowledge[]> {
    const result = await executor.execute({
      sql: "SELECT TOP (200) record_json FROM dbo.knowledge_versions WHERE organization_id=@org AND knowledge_id=@id ORDER BY version DESC",
      parameters: this.parameters(org, id),
    });
    return result.rows.map((row) =>
      parseStoredRecord(() => publishedKnowledgeSchema.parse(JSON.parse(String(row.record_json)))),
    );
  }
  async findVersion(
    org: string,
    id: string,
    version: number,
    executor = this.database,
  ): Promise<PublishedKnowledge | null> {
    const result = await executor.execute({
      sql: "SELECT record_json FROM dbo.knowledge_versions WHERE organization_id=@org AND knowledge_id=@id AND version=@version",
      parameters: [
        ...this.parameters(org, id),
        { name: "version", type: "integer", value: version },
      ],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          publishedKnowledgeSchema.parse(JSON.parse(String(result.rows[0].record_json))),
        )
      : null;
  }
  async findCandidatePublication(
    org: string,
    candidateId: string,
    executor: MetadataQueryExecutor,
  ): Promise<PublishedKnowledge | null> {
    const result = await executor.execute({
      sql: "SELECT TOP (1) record_json FROM dbo.knowledge_versions WHERE organization_id=@org AND JSON_VALUE(record_json,'$.source_candidate_id')=@id AND JSON_VALUE(record_json,'$.rollback_from_version') IS NULL ORDER BY version DESC",
      parameters: this.parameters(org, candidateId),
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          publishedKnowledgeSchema.parse(JSON.parse(String(result.rows[0].record_json))),
        )
      : null;
  }
  async findPublished(
    org: string,
    id: string,
    version: number | undefined,
    now: string,
    executor = this.database,
  ): Promise<PublishedKnowledge | null> {
    const result = await executor.execute({
      sql: "SELECT TOP (1) v.record_json FROM dbo.knowledge_versions v JOIN dbo.knowledge_heads h ON h.organization_id=v.organization_id AND h.knowledge_id=v.knowledge_id WHERE v.organization_id=@org AND v.knowledge_id=@id AND h.enabled=1 AND v.effective_at<=CONVERT(datetime2,@now) AND (@version IS NULL OR v.version=@version) ORDER BY v.version DESC",
      parameters: [
        ...this.parameters(org, id),
        { name: "version", type: "integer", value: version ?? null },
        { name: "now", type: "string", value: now },
      ],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          publishedKnowledgeSchema.parse(JSON.parse(String(result.rows[0].record_json))),
        )
      : null;
  }
  async listPublished(org: string, now: string): Promise<PublishedKnowledge[]> {
    const result = await this.database.execute({
      sql: "SELECT TOP (200) record_json FROM (SELECT v.record_json,v.knowledge_id,ROW_NUMBER() OVER(PARTITION BY v.knowledge_id ORDER BY v.version DESC) AS ordinal FROM dbo.knowledge_versions v JOIN dbo.knowledge_heads h ON h.organization_id=v.organization_id AND h.knowledge_id=v.knowledge_id WHERE v.organization_id=@org AND h.enabled=1 AND v.effective_at<=CONVERT(datetime2,@now)) versions WHERE ordinal=1 ORDER BY knowledge_id",
      parameters: [...this.parameters(org), { name: "now", type: "string", value: now }],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() => publishedKnowledgeSchema.parse(JSON.parse(String(row.record_json)))),
    );
  }
  async savePublished(input: PublishedKnowledge, executor: MetadataQueryExecutor): Promise<void> {
    const record = publishedKnowledgeSchema.parse(input);
    await executor.execute({
      sql: "IF NOT EXISTS(SELECT 1 FROM dbo.knowledge_heads WHERE organization_id=@org AND knowledge_id=@id) INSERT INTO dbo.knowledge_heads(organization_id,knowledge_id,enabled) VALUES(@org,@id,1); INSERT INTO dbo.knowledge_versions(organization_id,knowledge_id,version,effective_at,record_json) VALUES(@org,@id,@version,CONVERT(datetime2,@effective),@json)",
      parameters: [
        ...this.parameters(record.organization_id, record.knowledge_id),
        { name: "version", type: "integer", value: record.version },
        { name: "effective", type: "string", value: record.effective_at },
        { name: "json", type: "string", value: JSON.stringify(record) },
      ],
    });
    if (record.content.type === "metric")
      await new SqlMetricRepository(this.database).publishApproved(
        executor,
        record.organization_id,
        record.content.definition,
        record,
      );
    if (record.content.type === "report_template")
      await executor.execute({
        sql: "INSERT INTO dbo.report_template_publications(organization_id,report_id,definition_version,knowledge_id,knowledge_version,definition_hash) VALUES(@org,@report,@definition,@id,@version,@hash)",
        parameters: [
          ...this.parameters(record.organization_id, record.knowledge_id),
          { name: "report", type: "string", value: record.content.report_id },
          { name: "definition", type: "integer", value: record.content.definition_version },
          { name: "version", type: "integer", value: record.version },
          { name: "hash", type: "string", value: record.content.definition_hash },
        ],
      });
  }
  async setEnabled(
    org: string,
    id: string,
    enabled: boolean,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    await executor.execute({
      sql: "UPDATE dbo.knowledge_heads SET enabled=@enabled WHERE organization_id=@org AND knowledge_id=@id",
      parameters: [
        ...this.parameters(org, id),
        { name: "enabled", type: "boolean", value: enabled },
      ],
    });
  }
}
export { SqlKnowledgeRepository };
