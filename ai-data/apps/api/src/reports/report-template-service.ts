import { createHash } from "node:crypto";
import {
  stableStringify,
  reportDefinitionVersionSchema,
  publishedKnowledgeSchema,
  type KnowledgeContent,
  type MemoryScope,
  type ReportDefinitionVersion,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { runTime } from "../analysis-runs/run-time";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { DefinitionRepository } from "./report-definition-types";
import type { ReportQueryService } from "./report-query-service";

/** 发布只引用固定定义，发布映射与知识版本在知识事务内保存。 */
class ReportTemplateService {
  constructor(
    private readonly dependencies: {
      database: MetadataTransactionalExecutor;
      repository: DefinitionRepository;
      builder: Pick<ReportQueryService, "validate">;
      authorizeScope(
        context: AuthContext,
        scope: MemoryScope,
        executor?: MetadataQueryExecutor,
      ): Promise<void>;
    },
  ) {}
  async validate(
    context: AuthContext,
    content: Extract<KnowledgeContent, { type: "report_template" }>,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    const definition = await this.definition(context, content, executor);
    await this.dependencies.builder.validate(context, definition.definition, executor);
  }
  /** 固定版本的摘要与完整查询范围通过校验后才允许预览。 */
  async preview(
    context: AuthContext,
    content: Extract<KnowledgeContent, { type: "report_template" }>,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportDefinitionVersion> {
    const definition = await this.definition(context, content, executor);
    await this.dependencies.builder.validate(context, definition.definition, executor);
    return definition;
  }
  async assertSubmit(
    context: AuthContext,
    content: Extract<KnowledgeContent, { type: "report_template" }>,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    const head = await this.dependencies.repository.find(
      "report",
      context.organizationId,
      content.report_id,
      undefined,
      executor,
    );
    if (
      !head ||
      (head.user_id !== context.userId &&
        !context.roles.includes("system_admin") &&
        !context.permissions.includes("knowledge:manage"))
    )
      throw new ApplicationError("UNAUTHORIZED", "模板候选需要作者或知识维护权限");
  }
  private async definition(
    context: AuthContext,
    content: Extract<KnowledgeContent, { type: "report_template" }>,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportDefinitionVersion> {
    const saved = await this.dependencies.repository.find(
      "report",
      context.organizationId,
      content.report_id,
      content.definition_version,
      executor,
    );
    if (!saved) throw new ApplicationError("NOT_FOUND", "模板定义版本不存在");
    const record = reportDefinitionVersionSchema.parse(saved);
    if (
      createHash("sha256").update(stableStringify(record.definition)).digest("hex") !==
      content.definition_hash
    )
      throw new ApplicationError("CONFLICT", "模板内容摘要与固定版本不一致");
    return record;
  }
  /** 发现仅返回当前已生效发布版本；私有未审头版本不进入组织目录。 */
  async list(
    context: AuthContext,
    executor: MetadataQueryExecutor = this.dependencies.database,
  ): Promise<ReportDefinitionVersion[]> {
    const result = await executor.execute({
      sql: "SELECT record_json FROM (SELECT v.record_json,ROW_NUMBER() OVER(PARTITION BY v.knowledge_id ORDER BY v.version DESC) AS ordinal FROM dbo.knowledge_versions v JOIN dbo.knowledge_heads h ON h.organization_id=v.organization_id AND h.knowledge_id=v.knowledge_id WHERE v.organization_id=@org AND h.enabled=1 AND v.effective_at<=CONVERT(datetime2,@now)) versions WHERE ordinal=1",
      parameters: [
        { name: "org", type: "string", value: context.organizationId },
        { name: "now", type: "string", value: runTime() },
      ],
    });
    const records: ReportDefinitionVersion[] = [];
    for (const row of result.rows) {
      const publication = parseStoredRecord(() =>
        publishedKnowledgeSchema.parse(JSON.parse(String(row.record_json))),
      );
      if (publication.content.type !== "report_template") continue;
      try {
        await this.dependencies.authorizeScope(context, publication.scope, executor);
        const definition = await this.definition(context, publication.content, executor);
        await this.dependencies.builder.validate(context, definition.definition, executor);
        records.push(definition);
      } catch (error) {
        if (!(
          error instanceof ApplicationError &&
          [
            "NOT_FOUND",
            "UNAUTHORIZED",
            "UNAUTHORIZED_OBJECT",
            "UNAUTHORIZED_COLUMN",
            "POLICY_REJECTED",
          ].includes(error.code)
        ))
          throw error;
      }
    }
    return records;
  }
}
export { ReportTemplateService };
