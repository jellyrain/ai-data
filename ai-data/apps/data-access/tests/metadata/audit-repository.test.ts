import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { AuditRepository } from "../../src/metadata/audit-repository";

// 审计 ID 由执行器替身返回，断言检查 SQL 模板、JSON 序列化与参数绑定。
describe("查询审计仓储", () => {
  it("写入拒绝事件且不把审计内容拼接进 SQL", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new AuditRepository(createExecutor([{ audit_id: 101 }], statements));

    await expect(
      repository.write({
        correlationId: "correlation-001",
        analysisRunId: "run-001",
        userId: "user-001",
        organizationId: "org-001",
        policyVersion: 2,
        sourceId: "clinical_reporting",
        objectIds: ["clinical.surgery_record"],
        querySummary: { type: "relational_query" },
        parametersSummary: { start_date: "2026-08-01" },
        rowFilterInjected: true,
        outcome: "rejected",
        rejectionReason: "对象不在授权范围",
        errorCode: "OBJECT_NOT_AUTHORIZED",
      }),
    ).resolves.toBe(101);

    expect(statements[0]?.sql).toContain("OUTPUT INSERTED.audit_id");
    expect(statements[0]?.sql).not.toContain("对象不在授权范围");
    expect(statements[0]?.parameters).toContainEqual({
      name: "rejection_reason",
      type: "string",
      value: "对象不在授权范围",
    });
    expect(statements[0]?.parameters).toContainEqual({
      name: "object_ids_json",
      type: "string",
      value: '["clinical.surgery_record"]',
    });
  });
});

/** 创建记录参数化写入语句的元数据库执行器替身。 */
function createExecutor(
  rows: Record<string, unknown>[],
  statements: MetadataStatement[] = [],
): MetadataQueryExecutor {
  return {
    async execute<T extends Record<string, unknown>>(
      statement: MetadataStatement,
    ): Promise<MetadataQueryResult<T>> {
      statements.push(statement);
      return { rows: rows as T[], rowsAffected: [1] };
    },
  };
}
