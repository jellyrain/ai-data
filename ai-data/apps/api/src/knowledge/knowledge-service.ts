import { createHash, randomUUID } from "node:crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  knowledgeCandidateInputSchema,
  knowledgeCandidateSchema,
  knowledgePublishInputSchema,
  knowledgeReviewInputSchema,
  memoryScopeSchema,
  memorySourceSchema,
  metricDefinitionSchema,
  publishedKnowledgeSchema,
  stableStringify,
  type KnowledgeCandidate,
  type KnowledgeCandidateInput,
  type KnowledgeContent,
  type MemoryScope,
  type PublishedKnowledge,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { rollbackKnowledgeSchema, updateKnowledgeSchema } from "./knowledge-records";
import type { KnowledgeDependencies, KnowledgeSourceRecord } from "./knowledge-types";

dayjs.extend(utc);
/** 规范化标题、换行和首尾空白；内容摘要同时包含类型及适用范围。 */
function normalizeKnowledgeContent(content: KnowledgeContent): KnowledgeContent {
  if (content.type === "business_rule")
    return {
      type: content.type,
      title: content.title.normalize("NFC").trim(),
      body: content.body.normalize("NFC").replace(/\r\n?/g, "\n").trim(),
    };
  if (content.type === "report_template") return { ...content };
  return { type: "metric", definition: metricDefinitionSchema.parse(content.definition) };
}
function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
/** 权限错误可用于过滤集合；其他故障应交给统一错误边界。 */
function denied(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    [
      "UNAUTHORIZED",
      "UNAUTHORIZED_OBJECT",
      "UNAUTHORIZED_COLUMN",
      "POLICY_REJECTED",
      "NOT_FOUND",
    ].includes(error.code)
  );
}
/** 审核绑定候选版本；正式规则、指标版本及发布状态由同一事务提交。 */
class KnowledgeService {
  constructor(private readonly dependencies: KnowledgeDependencies) {}
  private time(): string {
    return dayjs(this.dependencies.now?.()).utcOffset(8).format("YYYY-MM-DD HH:mm:ss");
  }
  private manager(context: AuthContext): boolean {
    return (
      context.roles.includes("system_admin") || context.permissions.includes("knowledge:manage")
    );
  }
  private assertManager(context: AuthContext): void {
    if (!this.manager(context)) throw new ApplicationError("UNAUTHORIZED", "无知识管理权限");
  }
  private assertOwner(context: AuthContext, ownerId: string | null): void {
    if (!context.roles.includes("system_admin") && context.userId !== ownerId)
      throw new ApplicationError("UNAUTHORIZED", "仅指定负责人可以审核和发布");
  }
  private assertVersion(candidate: KnowledgeCandidate, version: number): void {
    if (candidate.version !== version) throw new ApplicationError("CONFLICT", "候选版本已更新");
  }
  private async validateContent(
    context: AuthContext,
    content: KnowledgeContent,
    scope: MemoryScope,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    if (content.type === "metric") {
      const metric = content.definition;
      if (
        (scope.source_id && scope.source_id !== metric.query.source_id) ||
        (scope.object_id && scope.object_id !== metric.query.from.object_id) ||
        (scope.metric_id && scope.metric_id !== metric.metric_id)
      )
        throw new ApplicationError("INVALID_INPUT", "指标适用范围必须与定义一致");
      await this.dependencies.authorizeScope(
        context,
        { source_id: metric.query.source_id, object_id: metric.query.from.object_id },
        executor,
      );
      await this.dependencies.metrics.validateDefinition(context, metric, executor);
    } else {
      await this.dependencies.authorizeScope(context, scope, executor);
      if (content.type === "report_template") {
        if (!this.dependencies.templates)
          throw new ApplicationError("UNSUPPORTED_QUERY", "报表模板发布未配置");
        await this.dependencies.templates.validate(context, content, executor);
      }
    }
  }
  private async candidate(
    context: AuthContext,
    id: string,
    executor?: MetadataQueryExecutor,
  ): Promise<KnowledgeCandidate> {
    const candidate = await this.dependencies.repository.findCandidate(
      context.organizationId,
      id,
      executor,
    );
    if (!candidate) throw new ApplicationError("NOT_FOUND", "候选不存在");
    return candidate;
  }
  /** 规则正文按完整来源范围复核，追加支持不能扩大原始内容的可读范围。 */
  private async authorizeSources(
    context: AuthContext,
    candidateId: string,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    const sources = await this.dependencies.repository.listSources(
      context.organizationId,
      candidateId,
      executor,
    );
    if (!sources.length) throw new ApplicationError("UNAUTHORIZED", "知识来源不可确认");
    for (const record of sources)
      await this.dependencies.validateSource(context, record.source, executor, true);
  }
  private async authorizeCandidate(
    context: AuthContext,
    candidate: KnowledgeCandidate,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    if (
      !this.manager(context) &&
      candidate.created_by !== context.userId &&
      candidate.owner_id !== context.userId
    ) {
      const supports = await this.dependencies.repository.listSources(
        context.organizationId,
        candidate.candidate_id,
        executor,
      );
      if (!supports.some((source) => source.user_id === context.userId))
        throw new ApplicationError("UNAUTHORIZED", "无权读取此候选");
    }
    await this.validateContent(context, candidate.content, candidate.scope, executor);
    if (candidate.content.type === "business_rule")
      await this.authorizeSources(context, candidate.candidate_id, executor);
  }
  async submit(
    context: AuthContext,
    input: KnowledgeCandidateInput,
    external?: MetadataQueryExecutor,
  ): Promise<KnowledgeCandidate> {
    const parsed = knowledgeCandidateInputSchema.parse(input);
    const content = normalizeKnowledgeContent(parsed.content);
    const request = knowledgeCandidateInputSchema.parse({ ...parsed, content });
    const requestHash = digest({ action: "submit", ...request });
    return this.dependencies.repository.transaction(
      context.organizationId,
      async (executor) => {
        await this.validateContent(context, content, request.scope, executor);
        if (content.type === "report_template")
          await this.dependencies.templates!.assertSubmit(context, content, executor);
        const source = memorySourceSchema.parse(request.source ?? {});
        source.evidence_ids.sort();
        await this.dependencies.validateSource(context, source, executor);
        const existing = await this.dependencies.repository.findOperation(
          context.organizationId,
          context.userId,
          request.idempotency_key,
          executor,
        );
        if (existing) {
          if (existing.request_hash !== requestHash)
            throw new ApplicationError("CONFLICT", "幂等键已用于其他知识操作");
          const result = knowledgeCandidateSchema.parse(existing.result);
          await this.authorizeCandidate(
            context,
            await this.candidate(context, result.candidate_id, executor),
            executor,
          );
          return result;
        }
        const contentHash = digest({ content, scope: request.scope });
        let candidate = await this.dependencies.repository.findDuplicate(
          context.organizationId,
          contentHash,
          executor,
        );
        const knowledgeId =
          content.type === "metric"
            ? content.definition.metric_id
            : (request.knowledge_id ?? randomUUID());
        if (
          content.type === "metric" &&
          request.knowledge_id &&
          request.knowledge_id !== knowledgeId
        )
          throw new ApplicationError("INVALID_INPUT", "指标知识标识必须等于指标标识");
        if (candidate && request.knowledge_id && candidate.knowledge_id !== request.knowledge_id)
          throw new ApplicationError("CONFLICT", "相同内容已属于其他知识记录");
        if (!candidate) {
          const previous = (
            await this.dependencies.repository.listVersions(
              context.organizationId,
              knowledgeId,
              executor,
            )
          )[0];
          if (previous) {
            await this.validateContent(context, previous.content, previous.scope, executor);
            if (previous.content.type !== content.type)
              throw new ApplicationError("INVALID_INPUT", "正式知识类型不能变更");
          }
          const now = this.time();
          candidate = knowledgeCandidateSchema.parse({
            candidate_id: randomUUID(),
            organization_id: context.organizationId,
            knowledge_id: knowledgeId,
            version: 1,
            content,
            scope: request.scope,
            content_hash: contentHash,
            status: "pending",
            created_by: context.userId,
            owner_id: previous?.owner_id ?? null,
            created_at: now,
            updated_at: now,
          });
          await this.dependencies.repository.saveCandidate(candidate, executor);
        }
        await this.dependencies.repository.addSource(
          context.organizationId,
          candidate.candidate_id,
          context.userId,
          source,
          executor,
        );
        await this.dependencies.repository.saveOperation(
          context.organizationId,
          context.userId,
          request.idempotency_key,
          { request_hash: requestHash, result: candidate },
          executor,
        );
        return candidate;
      },
      external,
    );
  }
  /** 既有指标管理入口接收完整定义，转为待审候选并返回候选状态。 */
  async submitMetric(context: AuthContext, input: unknown): Promise<KnowledgeCandidate> {
    if (!this.manager(context) && !context.permissions.includes("catalog:manage"))
      throw new ApplicationError("UNAUTHORIZED", "无指标管理权限");
    const definition = metricDefinitionSchema.parse(input);
    return this.submit(context, {
      idempotency_key: `metric:${digest(definition)}`,
      knowledge_id: definition.metric_id,
      content: { type: "metric", definition },
      scope: { source_id: definition.query.source_id, object_id: definition.query.from.object_id },
    });
  }
  async getCandidate(context: AuthContext, id: string): Promise<KnowledgeCandidate> {
    const candidate = await this.candidate(context, id);
    await this.authorizeCandidate(context, candidate);
    return candidate;
  }
  async listCandidates(context: AuthContext, management = false): Promise<KnowledgeCandidate[]> {
    if (management && !this.manager(context)) {
      return this.filter(
        context,
        (
          await this.dependencies.repository.listCandidates(context.organizationId, context.userId)
        ).filter((candidate) => candidate.owner_id === context.userId),
      );
    }
    return this.filter(
      context,
      await this.dependencies.repository.listCandidates(
        context.organizationId,
        management ? undefined : context.userId,
      ),
    );
  }
  private async filter(
    context: AuthContext,
    candidates: KnowledgeCandidate[],
  ): Promise<KnowledgeCandidate[]> {
    const result: KnowledgeCandidate[] = [];
    for (const candidate of candidates) {
      try {
        await this.authorizeCandidate(context, candidate);
        result.push(candidate);
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    return result;
  }
  async listSources(context: AuthContext, id: string): Promise<KnowledgeSourceRecord[]> {
    const candidate = await this.candidate(context, id);
    if (
      !this.manager(context) &&
      candidate.created_by !== context.userId &&
      candidate.owner_id !== context.userId
    )
      throw new ApplicationError("UNAUTHORIZED", "无权读取候选来源");
    await this.validateContent(context, candidate.content, candidate.scope);
    const result: KnowledgeSourceRecord[] = [];
    for (const record of await this.dependencies.repository.listSources(
      context.organizationId,
      id,
    )) {
      try {
        await this.dependencies.validateSource(context, record.source, undefined, true);
        result.push(record);
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    return result;
  }
  async support(context: AuthContext, id: string, input: unknown): Promise<KnowledgeCandidate> {
    const source = memorySourceSchema.parse(input);
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const candidate = await this.candidate(context, id, executor);
      await this.authorizeCandidate(context, candidate, executor);
      if (candidate.status === "withdrawn")
        throw new ApplicationError("CONFLICT", "已撤回候选不能补充来源");
      await this.dependencies.validateSource(context, source, executor);
      source.evidence_ids.sort();
      await this.dependencies.repository.addSource(
        context.organizationId,
        id,
        context.userId,
        source,
        executor,
      );
      return candidate;
    });
  }
  async update(context: AuthContext, id: string, input: unknown): Promise<KnowledgeCandidate> {
    const request = updateKnowledgeSchema.parse(input);
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const candidate = await this.candidate(context, id, executor);
      this.assertVersion(candidate, request.expected_version);
      if (!context.roles.includes("system_admin") && candidate.created_by !== context.userId)
        throw new ApplicationError("UNAUTHORIZED", "仅提交者可以编辑候选");
      if (["withdrawn", "published"].includes(candidate.status))
        throw new ApplicationError("CONFLICT", "该候选状态不能编辑，请创建新候选");
      const content = normalizeKnowledgeContent(request.content);
      if (
        content.type !== candidate.content.type ||
        (content.type === "metric" && content.definition.metric_id !== candidate.knowledge_id)
      )
        throw new ApplicationError("INVALID_INPUT", "候选类型和指标标识不能变更");
      await this.validateContent(context, content, request.scope, executor);
      if (content.type === "report_template")
        await this.dependencies.templates!.assertSubmit(context, content, executor);
      const hash = digest({ content, scope: request.scope });
      const duplicate = await this.dependencies.repository.findDuplicate(
        context.organizationId,
        hash,
        executor,
      );
      if (duplicate && duplicate.candidate_id !== id)
        throw new ApplicationError("CONFLICT", "相同内容已有候选");
      const updated = knowledgeCandidateSchema.parse({
        ...candidate,
        content,
        scope: request.scope,
        content_hash: hash,
        version: candidate.version + 1,
        status: "pending",
        updated_at: this.time(),
      });
      await this.dependencies.repository.saveCandidate(updated, executor);
      return updated;
    });
  }
  async withdraw(
    context: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<KnowledgeCandidate> {
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const candidate = await this.candidate(context, id, executor);
      this.assertVersion(candidate, expectedVersion);
      if (candidate.created_by !== context.userId && !context.roles.includes("system_admin"))
        throw new ApplicationError("UNAUTHORIZED", "仅提交者可以撤回候选");
      await this.authorizeCandidate(context, candidate, executor);
      if (candidate.status === "published")
        throw new ApplicationError("CONFLICT", "已发布候选不能撤回");
      const updated = { ...candidate, status: "withdrawn" as const, updated_at: this.time() };
      await this.dependencies.repository.saveCandidate(updated, executor);
      return updated;
    });
  }
  async assignOwner(
    context: AuthContext,
    id: string,
    ownerId: string,
    expectedVersion: number,
  ): Promise<KnowledgeCandidate> {
    this.assertManager(context);
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const candidate = await this.candidate(context, id, executor);
      this.assertVersion(candidate, expectedVersion);
      await this.authorizeCandidate(context, candidate, executor);
      if (["withdrawn", "published"].includes(candidate.status))
        throw new ApplicationError("CONFLICT", "该候选状态不能分配负责人");
      if (
        !(await this.dependencies.repository.isActiveUser(
          context.organizationId,
          ownerId,
          executor,
        ))
      )
        throw new ApplicationError("INVALID_INPUT", "负责人必须为组织内有效账号");
      const updated = {
        ...candidate,
        owner_id: ownerId,
        status: "pending" as const,
        updated_at: this.time(),
      };
      await this.dependencies.repository.saveCandidate(updated, executor);
      return updated;
    });
  }
  async review(context: AuthContext, id: string, input: unknown): Promise<KnowledgeCandidate> {
    const request = knowledgeReviewInputSchema.parse(input);
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const candidate = await this.candidate(context, id, executor);
      this.assertVersion(candidate, request.expected_version);
      this.assertOwner(context, candidate.owner_id);
      await this.authorizeCandidate(context, candidate, executor);
      const status = request.decision === "approve" ? "approved" : "rejected";
      if (candidate.status === status) {
        const review = (
          await this.dependencies.repository.listReviews(context.organizationId, id, executor)
        ).find((record) => record.candidate.version === candidate.version);
        if (
          review?.reviewed_by === context.userId &&
          review.decision === request.decision &&
          review.comment === request.comment
        )
          return candidate;
      }
      if (candidate.status !== "pending")
        throw new ApplicationError("CONFLICT", "当前候选状态不接受此审核");
      await this.dependencies.repository.saveReview(
        {
          review_id: randomUUID(),
          candidate,
          reviewed_by: context.userId,
          decision: request.decision,
          comment: request.comment,
          reviewed_at: this.time(),
        },
        executor,
      );
      const updated = { ...candidate, status, updated_at: this.time() } as KnowledgeCandidate;
      await this.dependencies.repository.saveCandidate(updated, executor);
      return updated;
    });
  }
  async listReviews(context: AuthContext, id: string) {
    await this.getCandidate(context, id);
    const result = [];
    for (const review of await this.dependencies.repository.listReviews(
      context.organizationId,
      id,
    )) {
      try {
        await this.validateContent(context, review.candidate.content, review.candidate.scope);
        result.push(review);
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    return result;
  }
  async publish(context: AuthContext, id: string, input: unknown): Promise<PublishedKnowledge> {
    const request = knowledgePublishInputSchema.parse(input);
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const candidate = await this.candidate(context, id, executor);
      this.assertVersion(candidate, request.expected_version);
      this.assertOwner(context, candidate.owner_id);
      await this.authorizeCandidate(context, candidate, executor);
      const versions = await this.dependencies.repository.listVersions(
        context.organizationId,
        candidate.knowledge_id,
        executor,
      );
      if (candidate.status === "published") {
        const previous = await this.dependencies.repository.findCandidatePublication(
          context.organizationId,
          id,
          executor,
        );
        if (previous?.effective_at === request.effective_at) return previous;
        throw new ApplicationError("CONFLICT", "候选已按其他发布时间发布");
      }
      if (candidate.status !== "approved")
        throw new ApplicationError("CONFLICT", "候选必须先通过当前版本审核");
      if (
        !candidate.owner_id ||
        !(await this.dependencies.repository.isActiveUser(
          context.organizationId,
          candidate.owner_id,
          executor,
        ))
      )
        throw new ApplicationError("INVALID_INPUT", "发布需要有效负责人");
      const latest = versions[0];
      if (latest && latest.content.type !== candidate.content.type)
        throw new ApplicationError("INVALID_INPUT", "正式知识类型不能变更");
      const record = publishedKnowledgeSchema.parse({
        organization_id: context.organizationId,
        knowledge_id: candidate.knowledge_id,
        version: (latest?.version ?? 0) + 1,
        content: candidate.content,
        scope: candidate.scope,
        owner_id: candidate.owner_id,
        published_by: context.userId,
        published_at: this.time(),
        effective_at: request.effective_at,
        source_candidate_id: id,
      });
      await this.dependencies.repository.savePublished(record, executor);
      await this.dependencies.repository.saveCandidate(
        { ...candidate, status: "published", updated_at: this.time() },
        executor,
      );
      return record;
    });
  }
  private async authorizePublished(
    context: AuthContext,
    record: PublishedKnowledge,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    await this.validateContent(context, record.content, record.scope, executor);
    if (record.content.type === "business_rule")
      await this.authorizeSources(context, record.source_candidate_id, executor);
  }
  async getPublished(
    context: AuthContext,
    id: string,
    version?: number,
  ): Promise<PublishedKnowledge> {
    const record = await this.dependencies.repository.findPublished(
      context.organizationId,
      id,
      version,
      this.time(),
    );
    if (!record) throw new ApplicationError("NOT_FOUND", "正式知识不存在或尚未生效");
    await this.authorizePublished(context, record);
    return record;
  }
  async listPublished(context: AuthContext, scope?: MemoryScope): Promise<PublishedKnowledge[]> {
    const requested = scope ? memoryScopeSchema.parse(scope) : undefined;
    const result: PublishedKnowledge[] = [];
    for (const record of await this.dependencies.repository.listPublished(
      context.organizationId,
      this.time(),
    )) {
      if (
        requested &&
        Object.entries(record.scope).some(
          ([key, value]) =>
            requested[key as keyof MemoryScope] !== undefined &&
            requested[key as keyof MemoryScope] !== value,
        )
      )
        continue;
      try {
        await this.authorizePublished(context, record);
        result.push(record);
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    return result;
  }
  async listVersions(context: AuthContext, id: string): Promise<PublishedKnowledge[]> {
    const versions = await this.dependencies.repository.listVersions(context.organizationId, id);
    if (!versions[0]) throw new ApplicationError("NOT_FOUND", "正式知识不存在");
    this.assertOwner(context, versions[0].owner_id);
    const result: PublishedKnowledge[] = [];
    for (const record of versions) {
      try {
        await this.authorizePublished(context, record);
        result.push(record);
      } catch (error) {
        if (!denied(error)) throw error;
      }
    }
    return result;
  }
  async setEnabled(context: AuthContext, id: string, enabled: boolean): Promise<void> {
    await this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const record = (
        await this.dependencies.repository.listVersions(context.organizationId, id, executor)
      )[0];
      if (!record) throw new ApplicationError("NOT_FOUND", "正式知识不存在");
      this.assertOwner(context, record.owner_id);
      await this.authorizePublished(context, record, executor);
      await this.dependencies.repository.setEnabled(context.organizationId, id, enabled, executor);
    });
  }
  async rollback(context: AuthContext, id: string, input: unknown): Promise<PublishedKnowledge> {
    const request = rollbackKnowledgeSchema.parse(input);
    return this.dependencies.repository.transaction(context.organizationId, async (executor) => {
      const versions = await this.dependencies.repository.listVersions(
        context.organizationId,
        id,
        executor,
      );
      const latest = versions[0];
      if (!latest) throw new ApplicationError("NOT_FOUND", "正式知识不存在");
      this.assertOwner(context, latest.owner_id);
      const requestHash = digest({ action: "rollback", id, ...request });
      const operation = await this.dependencies.repository.findOperation(
        context.organizationId,
        context.userId,
        request.idempotency_key,
        executor,
      );
      if (operation) {
        if (operation.request_hash !== requestHash)
          throw new ApplicationError("CONFLICT", "幂等键已用于其他知识操作");
        const result = publishedKnowledgeSchema.parse(operation.result);
        await this.authorizePublished(context, result, executor);
        return result;
      }
      if (latest.version !== request.expected_version)
        throw new ApplicationError("CONFLICT", "正式知识版本已更新");
      const previous = await this.dependencies.repository.findVersion(
        context.organizationId,
        id,
        request.version,
        executor,
      );
      if (!previous) throw new ApplicationError("NOT_FOUND", "回滚版本不存在");
      await this.authorizePublished(context, previous, executor);
      if (
        !(await this.dependencies.repository.isActiveUser(
          context.organizationId,
          latest.owner_id,
          executor,
        ))
      )
        throw new ApplicationError("INVALID_INPUT", "发布需要有效负责人");
      const content =
        previous.content.type === "metric"
          ? {
              type: "metric" as const,
              definition: {
                ...previous.content.definition,
                version:
                  latest.content.type === "metric" ? latest.content.definition.version + 1 : 1,
              },
            }
          : previous.content;
      const record = publishedKnowledgeSchema.parse({
        ...previous,
        content,
        version: latest.version + 1,
        owner_id: latest.owner_id,
        published_by: context.userId,
        published_at: this.time(),
        effective_at: request.effective_at,
        rollback_from_version: previous.version,
      });
      await this.dependencies.repository.savePublished(record, executor);
      await this.dependencies.repository.setEnabled(context.organizationId, id, true, executor);
      await this.dependencies.repository.saveOperation(
        context.organizationId,
        context.userId,
        request.idempotency_key,
        { request_hash: requestHash, result: record },
        executor,
      );
      return record;
    });
  }
}
export { KnowledgeService, normalizeKnowledgeContent };
