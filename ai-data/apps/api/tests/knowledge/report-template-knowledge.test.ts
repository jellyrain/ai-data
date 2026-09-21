import { describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { MemoryKnowledgeRepository } from "./memory-knowledge-repository";
import { context } from "../support/api-fixtures";

describe("组织报表模板审核", () => {
  it("固定定义版本及摘要经过负责人审核后发布，停用和回滚复用知识状态", async () => {
    const validate = vi.fn(async () => {});
    const service = new KnowledgeService({
      repository: new MemoryKnowledgeRepository(),
      metrics: { validateDefinition: async () => {} },
      authorizeScope: async () => {},
      validateSource: async () => {},
      templates: { validate, assertSubmit: async () => {} },
    });
    const candidate = await service.submit(
      { ...context, userId: "author" },
      {
        idempotency_key: "template",
        content: {
          type: "report_template",
          report_id: "r",
          definition_version: 2,
          definition_hash: "a".repeat(64),
        },
        scope: { source_id: "clinical" },
      },
    );
    expect(candidate.content).toMatchObject({ type: "report_template", definition_version: 2 });
    await service.assignOwner(context, candidate.candidate_id, "owner", 1);
    await expect(
      service.publish(context, candidate.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-20 00:00:00",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await service.review(context, candidate.candidate_id, {
      expected_version: 1,
      decision: "approve",
      comment: "验证通过",
    });
    const published = await service.publish(context, candidate.candidate_id, {
      expected_version: 1,
      effective_at: "2026-09-20 00:00:00",
    });
    expect((await service.getPublished(context, published.knowledge_id)).content).toEqual(
      candidate.content,
    );
    await service.setEnabled(context, published.knowledge_id, false);
    await expect(service.getPublished(context, published.knowledge_id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const rolled = await service.rollback(context, published.knowledge_id, {
      idempotency_key: "back",
      version: 1,
      expected_version: 1,
      effective_at: "2026-09-20 00:00:00",
    });
    expect(rolled.content).toEqual(candidate.content);
    expect(validate).toHaveBeenCalled();
  });
});
