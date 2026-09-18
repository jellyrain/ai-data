import { describe, expect, it, vi } from "vitest";
import {
  analysisRunSchema,
  queryDslSchema,
  type AnalysisRunState,
  type QueryEvidence,
  type SseEvent,
} from "@ai-data/contracts";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import type { RunChange } from "../../src/analysis-runs/analysis-run-types";
import { context } from "../support/api-fixtures";

function setup() {
  let clock = Date.parse("2026-09-14T00:00:00Z");
  let state = analysisRunSchema.parse({
    analysis_run_id: "run",
    conversation_id: "conversation",
    organization_id: context.organizationId,
    user_id: context.userId,
    status: "created",
    created_at: "2026-09-14 08:00:00",
    updated_at: "2026-09-14 08:00:00",
    lease_epoch: 0,
    lease: null,
    sequence: 0,
    clarification: null,
    evidence_ids: [],
    error: null,
  });
  const events: SseEvent[] = [];
  const evidence: QueryEvidence[] = [];
  const receipts = new Map<string, string>();
  const repository = {
    get: async () => structuredClone(state),
    change: async (
      _context: unknown,
      _id: string,
      action: (state: AnalysisRunState) => RunChange,
      receipt?: { key: string; hash: string },
    ) => {
      if (receipt && receipts.has(receipt.key)) {
        if (receipts.get(receipt.key) !== receipt.hash) throw new Error("幂等键已用于其他内容");
        return structuredClone(state);
      }
      const draft = structuredClone(state);
      const change = action(draft);
      for (const event of change.events ?? [])
        events.push({
          ...event,
          analysis_run_id: "run",
          conversation_id: "conversation",
          sequence: ++draft.sequence,
        } as SseEvent);
      evidence.push(...(change.evidence ?? []));
      state = draft;
      if (receipt) receipts.set(receipt.key, receipt.hash);
      return structuredClone(state);
    },
    listEvents: async () => events,
    listEvidence: async () => structuredClone(evidence),
  };
  const authorize = vi.fn(async (query: unknown) => ({
    request: { query: queryDslSchema.parse(query), access: { output_masks: [] } },
    token: "test",
  }));
  const refreshContext = vi.fn(async () => context);
  const execute = vi.fn(async () => ({
    columns: [{ name: "value", data_type: "integer" as const }],
    rows: [{ value: 7 }],
    row_count: 1,
    truncated: false,
  }));
  const service = new AnalysisRunService({
    repository,
    refreshContext,
    authorization: { authorize },
    client: { execute },
    now: () => clock,
    leaseMilliseconds: 3000,
  } as unknown as ConstructorParameters<typeof AnalysisRunService>[0]);
  return {
    service,
    repository,
    events,
    evidence,
    execute,
    authorize,
    refreshContext,
    advance: () => {
      clock += 4000;
    },
  };
}

describe("运行状态、租约、澄清与证据", () => {
  it("压缩事件按租约持久化，终态后拒绝晚到事件", async () => {
    const h = setup();
    const lease = await h.service.claim(context, "run", "worker");
    await h.service.recordCompaction(context, "run", lease, {
      itemId: "compact-1",
      status: "started",
    });
    expect(h.events.at(-1)).toMatchObject({
      type: "context_compaction",
      item_id: "compact-1",
      status: "started",
      occurred_at: "2026-09-14 08:00:00",
    });
    await expect(
      h.service.recordCompaction(
        context,
        "run",
        { ...lease, epoch: lease.epoch + 1 },
        { itemId: "compact-1", status: "completed" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await h.service.complete(context, "run", lease, "完成");
    await expect(
      h.service.recordCompaction(context, "run", lease, {
        itemId: "compact-1",
        status: "completed",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.events.filter((event) => event.type === "context_compaction")).toHaveLength(1);
  });
  it("长查询期间身份失效时不提交返回结果", async () => {
    const h = setup();
    const lease = await h.service.claim(context, "run", "worker");
    const output = {
      columns: [{ name: "value", data_type: "integer" as const }],
      rows: [{ value: 7 }],
      row_count: 1,
      truncated: false,
    };
    h.execute.mockImplementation(async () => {
      h.refreshContext.mockRejectedValue(new Error("会话已撤销"));
      return output;
    });
    await expect(
      h.service.query(context, "run", lease, "call", {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id", as: "value" }],
      }),
    ).rejects.toThrow("会话已撤销");
    expect(h.evidence).toEqual([]);
    expect((await h.repository.get()).status).toBe("failed");
  });
  it("租约过期后的失败不能阻止其他执行器恢复", async () => {
    const h = setup();
    const lease = await h.service.claim(context, "run", "first");
    h.advance();
    await h.service.fail(context, "run", lease, new Error("late"));
    expect((await h.service.claim(context, "run", "next")).epoch).toBe(2);
  });
  it("租约接管递增代次，旧执行器不能提交终态", async () => {
    const h = setup();
    const first = await h.service.claim(context, "run", "worker-1");
    await expect(h.service.claim(context, "run", "worker-2")).rejects.toThrow();
    h.advance();
    const second = await h.service.claim(context, "run", "worker-2");
    expect(second.epoch).toBe(first.epoch + 1);
    await expect(h.service.complete(context, "run", first, "late")).rejects.toThrow();
    await h.service.complete(context, "run", second, "完成");
    expect((await h.service.get(context, "run")).status).toBe("completed");
  });
  it("澄清回答幂等续接原运行，错误问题和选项被拒绝", async () => {
    const h = setup();
    const lease = await h.service.claim(context, "run", "worker");
    await h.service.clarify(context, "run", lease, {
      clarification_id: "q",
      question: "日期依据",
      options: [{ id: "visit", label: "就诊时间" }],
      allow_custom_input: false,
    });
    await expect(
      h.service.answer(context, "run", {
        clarification_id: "q",
        option_id: "bad",
        idempotency_key: "bad",
      }),
    ).rejects.toThrow();
    const answer = { clarification_id: "q", option_id: "visit", idempotency_key: "reply" };
    await h.service.answer(context, "run", answer);
    const count = h.events.length;
    await h.service.answer(context, "run", answer);
    expect(h.events).toHaveLength(count);
    expect((await h.service.get(context, "run")).status).toBe("created");
  });
  it("取消后拒绝晚到结果，重复取消保持终态", async () => {
    const h = setup();
    const lease = await h.service.claim(context, "run", "worker");
    await h.service.cancel(context, "run");
    await expect(h.service.complete(context, "run", lease, "late")).rejects.toThrow();
    await h.service.cancel(context, "run");
    expect(h.events.filter((event) => event.type === "run_cancelled")).toHaveLength(1);
  });
  it("查询证据与表格事件一起提交，同工具调用重试复用已完成结果", async () => {
    const h = setup();
    const query = {
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visit", alias: "v" },
      select: [{ field: "v.id", as: "value" }],
    };
    const lease = await h.service.claim(context, "run", "worker");
    const first = await h.service.query(context, "run", lease, "tool-1", query);
    const repeated = await h.service.query(context, "run", lease, "tool-1", query);
    expect(repeated.evidence_id).toBe(first.evidence_id);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.evidence).toHaveLength(1);
    expect(h.events.some((event) => event.type === "table")).toBe(true);
    h.authorize.mockRejectedValue(new Error("permission changed"));
    await expect(h.service.get(context, "run")).rejects.toThrow();
  });
});

describe("分析查询交付边界", () => {
  const query = {
    type: "relational_query",
    source_id: "clinical",
    from: { object_id: "visit", alias: "v" },
    select: [{ field: "v.id", as: "value" }],
  };
  it("HTTP 调用保留查询结果，持久化 SSE 只携带标明范围的样本", async () => {
    const h = setup();
    h.execute.mockResolvedValue({
      columns: [{ name: "value", data_type: "integer" }],
      rows: Array.from({ length: 200 }, (_, index) => ({ value: index })),
      row_count: 200,
      truncated: false,
    });
    const result = await h.service.execute(context, "run", "key", query);
    expect(result.result.rows).toHaveLength(200);
    const event = h.events.find((item) => item.type === "table");
    expect(event).toMatchObject({ result_row_count: 200, result_truncated: false, sampled: true });
    expect(event?.type === "table" && event.rows.length).toBe(100);
  });
  it("超量连接器响应不能进入证据与表格事件", async () => {
    const h = setup();
    h.execute.mockResolvedValue({
      columns: [{ name: "value", data_type: "integer" }],
      rows: Array.from({ length: 5001 }, (_, index) => ({ value: index })),
      row_count: 5001,
      truncated: false,
    });
    await expect(h.service.execute(context, "run", "key", query)).rejects.toMatchObject({
      code: "QUERY_LIMIT_EXCEEDED",
    });
    expect(h.evidence).toEqual([]);
    expect(h.events.some((item) => item.type === "table")).toBe(false);
  });
  it("历史未显式 limit 的查询仍可按原幂等键读取", async () => {
    const h = setup();
    await h.service.execute(context, "run", "key", query);
    delete h.evidence[0]!.requested_query.limit;
    delete h.evidence[0]!.authorized_query.limit;
    await expect(h.service.execute(context, "run", "key", query)).resolves.toHaveProperty(
      "evidence_id",
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
