import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  memoryScopeSchema,
  metricDefinitionSchema,
  publishedKnowledgeSchema,
  stableStringify,
  type MemoryScope,
  type MetricDefinition,
  type PublishedKnowledge,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { MetricRepository } from "./metric-types";
dayjs.extend(utc);
/** 指标定义与知识发布元信息同事务保存；查询仅选择启用且已生效的正式版本。 */
class SqlMetricRepository implements MetricRepository {
  constructor(
    private readonly database: MetadataQueryExecutor,
    private readonly now: () => Date = () => dayjs().toDate(),
  ) {}
  /** 由知识发布仓储调用，执行器属于保存该正式知识版本的同一事务。 */
  async publishApproved(
    executor: MetadataQueryExecutor,
    organizationId: string,
    input: MetricDefinition,
    publication: PublishedKnowledge,
  ): Promise<void> {
    const metric = metricDefinitionSchema.parse(input);
    const record = publishedKnowledgeSchema.parse(publication);
    if (
      record.organization_id !== organizationId ||
      record.content.type !== "metric" ||
      stableStringify(record.content.definition) !== stableStringify(metric)
    )
      throw new ApplicationError("INVALID_INPUT", "指标与正式发布内容不一致");
    const parameters = [
      { name: "org", type: "string" as const, value: organizationId },
      { name: "id", type: "string" as const, value: metric.metric_id },
    ];
    const formal = await executor.execute({
      sql: "SELECT record_json FROM dbo.knowledge_versions WHERE organization_id=@org AND knowledge_id=@knowledge AND version=@version",
      parameters: [
        ...parameters,
        { name: "knowledge", type: "string", value: record.knowledge_id },
        { name: "version", type: "integer", value: record.version },
      ],
    });
    const saved = formal.rows[0]
      ? parseStoredRecord(() =>
          publishedKnowledgeSchema.parse(JSON.parse(String(formal.rows[0].record_json))),
        )
      : null;
    if (!saved || stableStringify(saved) !== stableStringify(record))
      throw new ApplicationError("CONFLICT", "指标必须通过正式知识发布流程保存");
    const existing = await executor.execute({
      sql: "SELECT TOP (1) definition_json FROM dbo.metric_definitions WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND metric_id=@id ORDER BY version DESC",
      parameters,
    });
    const previous = existing.rows[0]
      ? parseStoredRecord(() =>
          metricDefinitionSchema.parse(JSON.parse(String(existing.rows[0].definition_json))),
        )
      : null;
    if (metric.version !== (previous?.version ?? 0) + 1)
      throw new ApplicationError("CONFLICT", "指标版本必须顺序递增，已发布版本不可改写");
    if (
      previous &&
      (stableStringify(previous.date_basis) !== stableStringify(metric.date_basis) ||
        previous.query.source_id !== metric.query.source_id ||
        previous.query.from.object_id !== metric.query.from.object_id)
    )
      throw new ApplicationError("INVALID_INPUT", "更换指标时间依据或来源时应使用独立指标标识");
    await executor.execute({
      sql: "INSERT INTO dbo.metric_definitions(organization_id,metric_id,version,definition_json) VALUES(@org,@id,@version,@json); INSERT INTO dbo.metric_publications(organization_id,metric_id,version,knowledge_id,knowledge_version,owner_user_id,effective_at,published_at,scope_json) VALUES(@org,@id,@version,@knowledge,@knowledgeVersion,@owner,CONVERT(datetime2,@effective),CONVERT(datetime2,@published),@scope)",
      parameters: [
        ...parameters,
        { name: "version", type: "integer", value: metric.version },
        { name: "json", type: "string", value: JSON.stringify(metric) },
        { name: "knowledge", type: "string", value: record.knowledge_id },
        { name: "knowledgeVersion", type: "integer", value: record.version },
        { name: "owner", type: "string", value: record.owner_id },
        { name: "effective", type: "string", value: record.effective_at },
        { name: "published", type: "string", value: record.published_at },
        { name: "scope", type: "string", value: JSON.stringify(record.scope) },
      ],
    });
  }
  async find(
    organizationId: string,
    metricId: string,
    version?: number,
  ): Promise<MetricDefinition | null> {
    const result = await this.database.execute({
      sql: "SELECT TOP (1) d.definition_json FROM dbo.metric_definitions d JOIN dbo.metric_publications p ON p.organization_id=d.organization_id AND p.metric_id=d.metric_id AND p.version=d.version JOIN dbo.knowledge_heads h ON h.organization_id=p.organization_id AND h.knowledge_id=p.knowledge_id JOIN dbo.knowledge_versions v ON v.organization_id=p.organization_id AND v.knowledge_id=p.knowledge_id AND v.version=p.knowledge_version WHERE d.organization_id=@org AND d.metric_id=@id AND h.enabled=1 AND p.effective_at<=CONVERT(datetime2,@now) AND (@version IS NULL OR d.version=@version) ORDER BY d.version DESC",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: metricId },
        { name: "version", type: "integer", value: version ?? null },
        {
          name: "now",
          type: "string",
          value: dayjs(this.now()).utcOffset(8).format("YYYY-MM-DD HH:mm:ss"),
        },
      ],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          metricDefinitionSchema.parse(JSON.parse(String(result.rows[0].definition_json))),
        )
      : null;
  }
  async list(organizationId: string): Promise<MetricDefinition[]> {
    const result = await this.database.execute({
      sql: "SELECT TOP (200) definition_json FROM (SELECT d.definition_json,d.metric_id,ROW_NUMBER() OVER(PARTITION BY d.metric_id ORDER BY d.version DESC) AS ordinal FROM dbo.metric_definitions d JOIN dbo.metric_publications p ON p.organization_id=d.organization_id AND p.metric_id=d.metric_id AND p.version=d.version JOIN dbo.knowledge_heads h ON h.organization_id=p.organization_id AND h.knowledge_id=p.knowledge_id JOIN dbo.knowledge_versions v ON v.organization_id=p.organization_id AND v.knowledge_id=p.knowledge_id AND v.version=p.knowledge_version WHERE d.organization_id=@org AND h.enabled=1 AND p.effective_at<=CONVERT(datetime2,@now)) versions WHERE ordinal=1 ORDER BY metric_id",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        {
          name: "now",
          type: "string",
          value: dayjs(this.now()).utcOffset(8).format("YYYY-MM-DD HH:mm:ss"),
        },
      ],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() =>
        metricDefinitionSchema.parse(JSON.parse(String(row.definition_json))),
      ),
    );
  }
  async findPublicationScope(
    organizationId: string,
    metricId: string,
    version: number,
  ): Promise<MemoryScope | null> {
    const result = await this.database.execute({
      sql: "SELECT scope_json FROM dbo.metric_publications WHERE organization_id=@org AND metric_id=@id AND version=@version",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: metricId },
        { name: "version", type: "integer", value: version },
      ],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          memoryScopeSchema.parse(JSON.parse(String(result.rows[0].scope_json))),
        )
      : null;
  }
}
export { SqlMetricRepository };
