import { describe, expect, it, vi } from "vitest";
import {
  reportDefinitionVersionSchema,
  reportExecutionSchema,
  queryEvidenceSchema,
  queryDslSchema,
  type ReportExecution,
} from "@ai-data/contracts";
import { ReportExecutionService } from "../../src/reports/report-execution-service";
import { context } from "../support/api-fixtures";
import type { ReportExecutionRepository } from "../../src/reports/report-execution-types";

const definition = reportDefinitionVersionSchema.parse({
  report_id: "report",
  version: 1,
  organization_id: "org",
  user_id: "user",
  created_at: "2026-09-21 08:00:00",
  definition: {
    title: "就诊",
    queries: [
      {
        query_id: "a",
        query: {
          type: "relational_query",
          source_id: "s",
          from: { object_id: "visits", alias: "v" },
          select: [{ field: "v.id" }],
        },
      },
    ],
    presentation: [
      {
        section_id: "main",
        title: "明细",
        blocks: [
          { block_id: "one", title: "明细", type: "table", query_ids: ["a"] },
          { block_id: "two", title: "另一处", type: "table", query_ids: ["a"] },
        ],
      },
    ],
  },
});
function setup(count = 1) {
  let record: ReportExecution | null = null;
  let hash = "";
  const recordDefinition = structuredClone(definition);
  if (count > 1)
    recordDefinition.definition.queries.push({
      ...recordDefinition.definition.queries[0],
      query_id: "b",
    });
  const query = queryDslSchema.parse(recordDefinition.definition.queries[0].query);
  const evidence = queryEvidenceSchema.parse({
    evidence_id: "e",
    tool_call_id: "a",
    analysis_run_id: "run",
    organization_id: "org",
    user_id: "user",
    created_at: "2026-09-21 08:00:00",
    requested_query: query,
    authorized_query: query,
    output_masks: [],
    result: {
      columns: [{ name: "id", data_type: "integer" }],
      rows: [{ id: 1 }],
      row_count: 1,
      truncated: false,
    },
  });
  let sequence = 0;
  const queryRun = vi.fn(async () => ({ ...evidence, evidence_id: `e${++sequence}` }));
  const authorizeEvidence = vi.fn(async () => {});
  const finish = vi.fn(async (_ctx, next: ReportExecution) => {
    record = reportExecutionSchema.parse(next);
    return record;
  });
  const repository: ReportExecutionRepository = {
    findOperation: async () => record && { record, requestHash: hash },
    start: async (_ctx, _id, requestHash: string, _key, version, parameters, deadline) => {
      hash = requestHash;
      record = reportExecutionSchema.parse({
        execution_id: "execution",
        report_id: "report",
        organization_id: "org",
        user_id: "user",
        definition_version: 1,
        definition: version.definition,
        parameters,
        status: "running",
        analysis_run_id: "run",
        lease_epoch: 1,
        deadline,
        created_at: "2026-09-21 08:00:00",
      });
      return { record, isNew: true };
    },
    find: async () => record,
    finish,
  };
  const runs = {
    claim: vi.fn(async () => ({ owner: "worker", epoch: 1, expires_at: "2099-01-01 00:00:00" })),
    query: queryRun,
    complete: vi.fn(async (_ctx, _id, _lease, _text, apply) => {
      await apply({});
    }),
    fail: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    renew: vi.fn(async () => ({ owner: "worker", epoch: 1, expires_at: "2099-01-01 00:00:00" })),
  };
  const service = new ReportExecutionService({
    repository,
    definitions: { get: async () => recordDefinition },
    builder: {
      build: async () => ({
        parameters: {},
        queries: recordDefinition.definition.queries.map((q) => ({ query_id: q.query_id, query })),
      }),
    },
    runs,
    refreshContext: async () => context,
    authorizeEvidence,
    timeoutMilliseconds: 2000,
  } as unknown as ConstructorParameters<typeof ReportExecutionService>[0]);
  return {
    service,
    queryRun,
    finish,
    runs,
    evidence,
    authorizeEvidence,
    recordDefinition,
    record: () => record,
  };
}
describe("统一报表执行", () => {
  it("长查询标识仍使用有界操作键并保持展示引用", async () => {
    const h = setup();
    const id = "q".repeat(128);
    h.recordDefinition.definition.queries[0].query_id = id;
    for (const block of h.recordDefinition.definition.presentation[0].blocks)
      block.query_ids = [id];
    const result = await h.service.execute(context, "report", {
      definition_version: 1,
      idempotency_key: "long",
    });
    expect(result.status).toBe("completed");
    const calls = h.queryRun.mock.calls as unknown as unknown[][];
    expect(String(calls[0][3]).length).toBeLessThanOrEqual(128);
    expect(result.results[0].query_id).toBe(id);
  });
  it("模型未装配时执行并保存结果，同一查询的多个展示引用只查一次", async () => {
    const h = setup();
    const result = await h.service.execute(context, "report", {
      definition_version: 1,
      idempotency_key: "key",
    });
    expect(result.status).toBe("completed");
    expect(result.snapshot?.sections[0].blocks).toHaveLength(2);
    expect(h.queryRun).toHaveBeenCalledTimes(1);
    expect(
      (
        await h.service.execute(context, "report", {
          definition_version: 1,
          idempotency_key: "key",
        })
      ).execution_id,
    ).toBe(result.execution_id);
    expect(h.queryRun).toHaveBeenCalledTimes(1);
    await expect(
      h.service.execute(context, "report", { definition_version: 2, idempotency_key: "key" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("第二项失败时整体失败，保留审计运行且没有完成快照", async () => {
    const h = setup(2);
    h.queryRun.mockResolvedValueOnce(h.evidence).mockRejectedValueOnce(new Error("query failed"));
    const result = await h.service.execute(context, "report", {
      definition_version: 1,
      idempotency_key: "key",
    });
    expect(result.status).toBe("failed");
    expect(result.snapshot).toBeUndefined();
    expect(result.results).toEqual([]);
    expect(h.runs.fail).toHaveBeenCalled();
  });
  it("读取结果时重新验证每份历史证据", async () => {
    const h = setup();
    await h.service.execute(context, "report", { definition_version: 1, idempotency_key: "key" });
    const result = await h.service.get(context, "execution");
    expect(result.results).toHaveLength(1);
    expect(h.authorizeEvidence).toHaveBeenCalledTimes(2);
  });
  it("每项在五千行内但合计超预算时失败，不能保存部分快照", async () => {
    const h = setup(2);
    h.queryRun.mockImplementation(async () => ({
      ...h.evidence,
      result: {
        ...h.evidence.result,
        rows: Array.from({ length: 3000 }, (_, id) => ({ id })),
        row_count: 3000,
      },
    }));
    const result = await h.service.execute(context, "report", {
      definition_version: 1,
      idempotency_key: "budget",
    });
    expect(result).toMatchObject({
      status: "failed",
      error_code: "QUERY_LIMIT_EXCEEDED",
      results: [],
    });
    expect(h.runs.complete).not.toHaveBeenCalled();
  });
  it("超时先保存失败，晚到查询不能覆盖失败终态", async () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      let release!: (value: typeof h.evidence) => void;
      h.queryRun.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = h.service.execute(context, "report", {
        definition_version: 1,
        idempotency_key: "timeout",
      });
      await vi.advanceTimersByTimeAsync(2001);
      expect(await pending).toMatchObject({ status: "failed", error_code: "QUERY_TIMEOUT" });
      release(h.evidence);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.runs.complete).not.toHaveBeenCalled();
      expect(h.record()?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
  it("旧说明保留在原执行，不作为新运行的结论", async () => {
    const h = setup();
    h.recordDefinition.definition.presentation[0].blocks.push({
      block_id: "old",
      type: "text",
      title: "旧结论",
      query_ids: ["a"],
      content: "原先100人",
    });
    const result = await h.service.execute(context, "report", {
      definition_version: 1,
      idempotency_key: "text",
    });
    expect(
      result.snapshot?.sections
        .flatMap((section) => section.blocks)
        .some((block) => block.block_id === "old"),
    ).toBe(false);
  });
});
