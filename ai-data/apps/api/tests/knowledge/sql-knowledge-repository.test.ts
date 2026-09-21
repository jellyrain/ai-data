import { describe, expect, it, vi } from "vitest";
import type { MetadataStatement, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { SqlKnowledgeRepository } from "../../src/knowledge/sql-knowledge-repository";

describe("知识来源完整读取边界", () => {
  it("TOP 201 探测到来源超过 200 条时拒绝返回部分可读引用", async () => {
    const execute = vi.fn(async (statement: MetadataStatement) => ({
      rows: Array.from({ length: 201 }, () => ({
        user_id: "user",
        source_json: '{"evidence_ids":[]}',
      })),
      rowsAffected: statement.parameters.length ? [0] : [],
    }));
    const database = { execute, transaction: vi.fn() } as unknown as MetadataTransactionalExecutor;
    const repository = new SqlKnowledgeRepository(database);
    await expect(repository.listSources("org", "candidate")).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ sql: expect.stringContaining("TOP (201)") });
  });
});
