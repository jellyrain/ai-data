import { z } from "zod";
import {
  memoryScopeSchema,
  memorySourceSchema,
  queryEvidenceSchema,
  type MemoryScope,
  type MemorySource,
  type UserPreferenceInput,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type { ApiQueryAuthorization } from "../app-types";
import type { BusinessCatalogService } from "../catalog/business-catalog-service";
import { ApplicationError } from "../errors/application-error";
import { assertEvidenceAccess } from "../evidence/evidence-access";
import { SqlMetricRepository } from "../metrics/sql-metric-repository";
import { parseStoredRecord } from "../metadata/parse-stored-record";

/** 记忆不会授予权限：范围、字段及原证据逐次用当前身份核对。 */
class MemoryAccess {
  constructor(
    private readonly dependencies: {
      database: MetadataQueryExecutor;
      catalog(executor: MetadataQueryExecutor): BusinessCatalogService;
      authorization(executor: MetadataQueryExecutor): ApiQueryAuthorization;
    },
  ) {}
  async scope(
    context: AuthContext,
    input: MemoryScope,
    executor = this.dependencies.database,
  ): Promise<void> {
    const scope = memoryScopeSchema.parse(input);
    if (scope.source_id) {
      const catalog = this.dependencies.catalog(executor);
      if (
        scope.object_id
          ? !(await catalog.getAuthorized(context, scope.source_id, scope.object_id))
          : !(await catalog.listAuthorized(context, scope.source_id)).length
      )
        throw new ApplicationError("UNAUTHORIZED", "记忆适用范围无权访问");
    }
    if (scope.metric_id && !scope.object_id) await this.metric(context, scope.metric_id, executor);
  }
  private async metric(context: AuthContext, id: string, executor: MetadataQueryExecutor) {
    const metric = await new SqlMetricRepository(executor).find(context.organizationId, id);
    if (!metric) throw new ApplicationError("NOT_FOUND", "偏好引用的指标未生效或已停用");
    await this.dependencies.authorization(executor).authorize(metric.query, context);
    return metric;
  }
  async preference(
    context: AuthContext,
    input: UserPreferenceInput,
    executor = this.dependencies.database,
  ): Promise<void> {
    await this.scope(context, input.scope, executor);
    const value = input.value;
    const metricId =
      value.type === "metric"
        ? value.metric_id
        : value.type === "query_habit"
          ? (value.metric_id ?? input.scope.metric_id)
          : input.scope.metric_id;
    const metric = metricId ? await this.metric(context, metricId, executor) : null;
    const conditions =
      value.type === "filters"
        ? value.conditions
        : value.type === "query_habit"
          ? value.filters
          : [];
    const fields =
      value.type === "grouping"
        ? value.fields
        : value.type === "query_habit"
          ? value.dimensions
          : [];
    if (!conditions.length && !fields.length) return;
    const sourceId = input.scope.source_id ?? metric?.query.source_id,
      objectId = input.scope.object_id ?? metric?.query.from.object_id;
    if (!sourceId || !objectId) throw new ApplicationError("INVALID_INPUT", "字段偏好缺少对象范围");
    const found = await this.dependencies
      .catalog(executor)
      .getAuthorized(context, sourceId, objectId);
    if (!found) throw new ApplicationError("UNAUTHORIZED", "偏好对象无权访问");
    const columns = new Map(found.dataset.columns.map((column) => [column.name, column]));
    const columnName = (field: string) => field.split(".").at(-1)!;
    for (const field of [...fields, ...conditions.map((item) => item.field)])
      if (!columns.has(columnName(field)))
        throw new ApplicationError("UNAUTHORIZED", "偏好字段无权访问");
    for (const condition of conditions)
      if (columns.get(columnName(condition.field))!.data_type !== condition.data_type)
        throw new ApplicationError("INVALID_INPUT", "偏好字段类型已变化");
    // 使用当前查询授权复核筛选操作和字段策略，行范围仍由授权服务叠加。
    await this.dependencies.authorization(executor).authorize(
      {
        type: "relational_query",
        source_id: sourceId,
        from: { object_id: objectId, alias: "m" },
        select: [...new Set([...fields, ...conditions.map((item) => item.field)])].map((field) => ({
          field: "m." + columnName(field),
        })),
        filters: {
          logic: "and",
          items: conditions.map((item) => ({ ...item, field: "m." + columnName(item.field) })),
        },
        limit: 1,
      },
      context,
    );
  }
  /** 共享引用仅由候选归属/负责人或正式知识授权之后传入；不会读取来源消息正文。 */
  async source(
    context: AuthContext,
    input: MemorySource,
    executor = this.dependencies.database,
    allowSharedEvidence = false,
  ): Promise<void> {
    const source = memorySourceSchema.parse(input);
    const parameters = [{ name: "org", type: "string" as const, value: context.organizationId }];
    let conversationId = source.conversation_id;
    let ownerId: string | undefined;
    if (source.analysis_run_id) {
      const result = await executor.execute({
        sql: "SELECT conversation_id,user_id FROM dbo.analysis_runs WHERE id=@id AND organization_id=@org",
        parameters: [...parameters, { name: "id", type: "string", value: source.analysis_run_id }],
      });
      const row = result.rows[0];
      if (!row) throw new ApplicationError("NOT_FOUND", "记忆来源运行不存在");
      if (conversationId && conversationId !== row.conversation_id)
        throw new ApplicationError("INVALID_INPUT", "记忆来源会话与运行不一致");
      conversationId = z.string().parse(row.conversation_id);
      ownerId = z.string().parse(row.user_id);
    }
    if (source.message_id) {
      const result = await executor.execute({
        sql: "SELECT m.conversation_id,m.analysis_run_id,c.user_id FROM dbo.conversation_messages m JOIN dbo.conversations c ON c.id=m.conversation_id WHERE m.id=@id AND c.organization_id=@org",
        parameters: [...parameters, { name: "id", type: "string", value: source.message_id }],
      });
      const row = result.rows[0];
      if (!row) throw new ApplicationError("NOT_FOUND", "记忆来源消息不存在");
      if (
        (conversationId && conversationId !== row.conversation_id) ||
        (source.analysis_run_id && source.analysis_run_id !== row.analysis_run_id)
      )
        throw new ApplicationError("INVALID_INPUT", "记忆来源消息归属不一致");
      conversationId = z.string().parse(row.conversation_id);
      ownerId = z.string().parse(row.user_id);
    }
    if (conversationId) {
      const result = await executor.execute({
        sql: "SELECT user_id FROM dbo.conversations WHERE id=@id AND organization_id=@org",
        parameters: [...parameters, { name: "id", type: "string", value: conversationId }],
      });
      if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", "记忆来源会话不存在");
      ownerId = z.string().parse(result.rows[0].user_id);
    }
    if (ownerId && ownerId !== context.userId && !allowSharedEvidence)
      throw new ApplicationError("UNAUTHORIZED", "记忆来源不属于当前账号");
    for (const id of source.evidence_ids) {
      const result = await executor.execute({
        sql: "SELECT e.evidence_json,r.conversation_id FROM dbo.analysis_evidence e JOIN dbo.analysis_runs r ON r.id=e.analysis_run_id WHERE e.evidence_id=@id AND r.organization_id=@org",
        parameters: [...parameters, { name: "id", type: "string", value: id }],
      });
      const row = result.rows[0];
      if (!row) throw new ApplicationError("NOT_FOUND", "记忆来源证据不存在");
      const evidence = parseStoredRecord(() =>
        queryEvidenceSchema.parse(JSON.parse(String(row.evidence_json))),
      );
      if (
        (source.analysis_run_id && source.analysis_run_id !== evidence.analysis_run_id) ||
        (conversationId && conversationId !== row.conversation_id) ||
        (!allowSharedEvidence && evidence.user_id !== context.userId)
      )
        throw new ApplicationError("UNAUTHORIZED", "记忆来源证据归属不一致");
      await assertEvidenceAccess(evidence, context, this.dependencies.authorization(executor));
    }
  }
  async currentSource(
    context: AuthContext,
    runId: string,
    executor = this.dependencies.database,
  ): Promise<{ source: MemorySource; text: string }> {
    const result = await executor.execute({
      sql: "SELECT TOP (1) r.conversation_id,m.id AS message_id,m.content FROM dbo.analysis_runs r JOIN dbo.conversation_messages m ON m.analysis_run_id=r.id WHERE r.id=@id AND r.organization_id=@org AND r.user_id=@user AND m.role='user' ORDER BY m.sequence",
      parameters: [
        { name: "id", type: "string", value: runId },
        { name: "org", type: "string", value: context.organizationId },
        { name: "user", type: "string", value: context.userId },
      ],
    });
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "当前运行用户消息不存在");
    return parseStoredRecord(() => ({
      source: memorySourceSchema.parse({
        conversation_id: row.conversation_id,
        analysis_run_id: runId,
        message_id: row.message_id,
        evidence_ids: [],
      }),
      text: z.string().parse(row.content),
    }));
  }
}

export { MemoryAccess };
