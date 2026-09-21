import { describe, expect, it, vi } from "vitest";
import dayjs from "dayjs";
import { metricDefinitionSchema, type KnowledgeCandidateInput } from "@ai-data/contracts";
import { ApplicationError } from "../../src/errors/application-error";
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { MemoryKnowledgeRepository } from "./memory-knowledge-repository";
import type { AuthContext } from "../../src/auth/auth-types";
import type { KnowledgeDependencies } from "../../src/knowledge/knowledge-types";

const author: AuthContext = {
  userId: "author",
  organizationId: "org",
  sessionId: "session",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
const owner = { ...author, userId: "owner" };
const admin = { ...author, userId: "admin", roles: ["system_admin"] };
const input: KnowledgeCandidateInput = {
  idempotency_key: "first",
  content: { type: "business_rule", title: "门诊规则", body: "按就诊日期统计" },
  scope: { source_id: "clinical", object_id: "visits" },
};
function fixture() {
  const repository = new MemoryKnowledgeRepository();
  const authorizeScope = vi.fn<KnowledgeDependencies["authorizeScope"]>(async () => {});
  const validateSource = vi.fn<KnowledgeDependencies["validateSource"]>(async () => {});
  const service = new KnowledgeService({
    repository,
    metrics: { validateDefinition: vi.fn(async () => {}) },
    authorizeScope,
    validateSource,
    now: () => dayjs("2026-09-20T02:00:00Z").toDate(),
  });
  return { service, repository, authorizeScope, validateSource };
}
describe("企业知识候选审核发布", () => {
  it("相同规范化内容并发提交只建一条候选，重试不重复追加来源", async () => {
    const { service, repository } = fixture();
    const [first, duplicate] = await Promise.all([
      service.submit(author, input),
      service.submit(author, {
        ...input,
        idempotency_key: "second",
        content: { type: "business_rule", title: " 门诊规则 ", body: "按就诊日期统计\r\n" },
      }),
    ]);
    expect(duplicate.candidate_id).toBe(first.candidate_id);
    expect((await service.submit(author, input)).candidate_id).toBe(first.candidate_id);
    expect(repository.candidates.size).toBe(1);
    expect(repository.sources.size).toBe(1);
    expect(await service.listPublished(author)).toEqual([]);
    await expect(
      service.submit(author, {
        ...input,
        content: { type: "business_rule", title: "改变", body: "改变" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("只有组织内有效负责人或系统管理员能审核固定版本，修改后重新审核", async () => {
    const { service } = fixture();
    const candidate = await service.submit(author, input);
    await expect(
      service.assignOwner(admin, candidate.candidate_id, "disabled", 1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await service.assignOwner(admin, candidate.candidate_id, owner.userId, 1);
    await expect(
      service.review(author, candidate.candidate_id, {
        expected_version: 1,
        decision: "approve",
        comment: "同意",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await service.review(owner, candidate.candidate_id, {
      expected_version: 1,
      decision: "approve",
      comment: "同意",
    });
    const edited = await service.update(author, candidate.candidate_id, {
      expected_version: 1,
      content: { type: "business_rule", title: "门诊规则", body: "按有效就诊统计" },
      scope: input.scope,
    });
    expect(edited).toMatchObject({ version: 2, status: "pending" });
    await expect(
      service.publish(owner, candidate.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-20 10:00:00",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.publish(owner, candidate.candidate_id, {
        expected_version: 2,
        effective_at: "2026-09-20 10:00:00",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("发布选择已到生效时间的版本，停用阻止读取，回滚发布新的不可变版本", async () => {
    const { service } = fixture();
    const first = await service.submit(author, input);
    await service.assignOwner(admin, first.candidate_id, owner.userId, 1);
    await service.review(owner, first.candidate_id, {
      expected_version: 1,
      decision: "approve",
      comment: "同意",
    });
    const published = await service.publish(owner, first.candidate_id, {
      expected_version: 1,
      effective_at: "2026-09-19 10:00:00",
    });
    expect(
      (
        await service.publish(owner, first.candidate_id, {
          expected_version: 1,
          effective_at: "2026-09-19 10:00:00",
        })
      ).version,
    ).toBe(1);
    const second = await service.submit(author, {
      ...input,
      idempotency_key: "next",
      knowledge_id: first.knowledge_id,
      content: { type: "business_rule", title: "新版规则", body: "新版" },
    });
    await service.review(owner, second.candidate_id, {
      expected_version: 1,
      decision: "approve",
      comment: "同意",
    });
    await service.publish(owner, second.candidate_id, {
      expected_version: 1,
      effective_at: "2026-10-01 00:00:00",
    });
    expect(await service.getPublished(author, first.knowledge_id)).toEqual(published);
    await expect(service.getPublished(author, first.knowledge_id, 2)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await service.setEnabled(owner, first.knowledge_id, false);
    expect(await service.listPublished(author)).toEqual([]);
    await expect(service.getPublished(author, first.knowledge_id, 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const rollback = await service.rollback(owner, first.knowledge_id, {
      version: 1,
      expected_version: 2,
      effective_at: "2026-09-20 10:00:00",
      idempotency_key: "rollback",
    });
    expect(rollback).toMatchObject({
      version: 3,
      rollback_from_version: 1,
      content: input.content,
    });
    expect((await service.getPublished(author, first.knowledge_id)).version).toBe(3);
  });
  it("读取复核当前范围，来源只返回当前可访问的引用", async () => {
    const { service, validateSource, authorizeScope } = fixture();
    const candidate = await service.submit(author, {
      ...input,
      source: { analysis_run_id: "run", evidence_ids: ["evidence"] },
    });
    await expect(
      service.getCandidate({ ...author, organizationId: "other" }, candidate.candidate_id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getCandidate(owner, candidate.candidate_id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    validateSource.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED", "失权"));
    await expect(service.listSources(author, candidate.candidate_id)).resolves.toEqual([]);
    authorizeScope.mockRejectedValueOnce(new ApplicationError("UNAUTHORIZED_OBJECT", "失权"));
    await expect(service.getCandidate(author, candidate.candidate_id)).rejects.toMatchObject({
      code: "UNAUTHORIZED_OBJECT",
    });
  });
  it("追加手工支持后原始来源失权仍拒绝正文，后台传递现有事务执行器", async () => {
    const { service, repository, validateSource, authorizeScope } = fixture();
    const candidate = await service.submit(
      author,
      { ...input, source: { analysis_run_id: "private", evidence_ids: ["evidence"] } },
      repository.executor,
    );
    await service.support(author, candidate.candidate_id, {});
    expect(authorizeScope).toHaveBeenCalledWith(author, input.scope, repository.executor);
    expect(validateSource).toHaveBeenCalledWith(
      author,
      { analysis_run_id: "private", evidence_ids: ["evidence"] },
      repository.executor,
    );
    validateSource.mockImplementation(async (_context, source) => {
      if (source.analysis_run_id === "private")
        throw new ApplicationError("UNAUTHORIZED", "来源权限变化");
    });
    await expect(service.getCandidate(author, candidate.candidate_id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await service.listSources(author, candidate.candidate_id)).toEqual([
      { user_id: author.userId, source: { evidence_ids: [] } },
    ]);
  });
  it("并发不同审核只有先提交者生效，拒绝后撤回保留状态并允许重新提交", async () => {
    const { service } = fixture();
    const candidate = await service.submit(author, input);
    await service.assignOwner(admin, candidate.candidate_id, owner.userId, 1);
    const results = await Promise.allSettled([
      service.review(owner, candidate.candidate_id, {
        expected_version: 1,
        decision: "reject",
        comment: "口径需修订",
      }),
      service.review(owner, candidate.candidate_id, {
        expected_version: 1,
        decision: "approve",
        comment: "通过",
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await expect(
      service.publish(owner, candidate.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-20 10:00:00",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.withdraw(author, candidate.candidate_id, 1)).status).toBe("withdrawn");
    expect(
      (await service.submit(author, { ...input, idempotency_key: "resubmit" })).candidate_id,
    ).not.toBe(candidate.candidate_id);
  });
  it("同一知识标识的并行候选在发布时仍保持正式知识类型", async () => {
    const { service } = fixture();
    const first = await service.submit(author, { ...input, knowledge_id: "visits" });
    const metric = metricDefinitionSchema.parse({
      metric_id: "visits",
      version: 1,
      name: "就诊",
      description: "按就诊日期",
      aliases: [],
      grain: "就诊",
      deduplication_keys: ["v.id"],
      date_basis: { field: "v.date", data_type: "date" },
      dimensions: [],
      total_rule: "recalculate",
      value: { type: "column", column: "value" },
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visits", alias: "v" },
        select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
      },
    });
    const second = await service.submitMetric(admin, metric);
    for (const candidate of [first, second]) {
      await service.assignOwner(admin, candidate.candidate_id, owner.userId, 1);
      await service.review(owner, candidate.candidate_id, {
        expected_version: 1,
        decision: "approve",
        comment: "同意",
      });
    }
    await service.publish(owner, first.candidate_id, {
      expected_version: 1,
      effective_at: "2026-09-20 10:00:00",
    });
    await expect(
      service.publish(owner, second.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-20 10:00:00",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
