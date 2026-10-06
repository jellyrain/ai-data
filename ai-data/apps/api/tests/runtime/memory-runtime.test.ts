import { describe, expect, it, vi } from "vitest";
import { userPreferenceInputSchema, type PublishedKnowledge } from "@ai-data/contracts";
import { isExplicitPreferenceRequest } from "../../src/memory/preference-instruction";
import { captureQueryHabit } from "../../src/memory/query-habit";
import { MemoryRuntime } from "../../src/memory/memory-runtime";
import { context } from "../support/api-fixtures";

describe("对话记忆接入", () => {
  it("初始仅带通用正式规则，指标和对象规则按需读取，索引不含正文", async () => {
    const knowledge = [
      {
        knowledge_id: "global",
        version: 1,
        content: { type: "business_rule", title: "通用口径", body: "GENERAL_RULE" },
        scope: {},
      },
      {
        knowledge_id: "local",
        version: 1,
        content: { type: "business_rule", title: "支付口径", body: "PAYMENT_RULE" },
        scope: { source_id: "s", object_id: "payment" },
      },
      {
        knowledge_id: "metric",
        version: 1,
        content: { type: "metric", definition: { name: "费用", query: "FULL_METRIC" } },
        scope: { metric_id: "fee" },
      },
    ] as unknown as PublishedKnowledge[];
    const service = new MemoryRuntime({
      preferences: { list: async () => [], listPendingConfirmations: async () => [] },
      knowledge: {
        listPublished: async () => knowledge,
        getPublished: async (_context: unknown, id: string) =>
          knowledge.find((item) => item.knowledge_id === id),
      },
    } as unknown as ConstructorParameters<typeof MemoryRuntime>[0]);
    expect((await service.snapshot(context)).knowledge.map((item) => item.knowledge_id)).toEqual([
      "global",
    ]);
    expect(await service.preferences(context)).not.toHaveProperty("knowledge");
    const index = await service.knowledge(context);
    expect(JSON.stringify(index)).not.toContain("FULL_METRIC");
    expect(JSON.stringify(index)).not.toContain("PAYMENT_RULE");
    expect(await service.knowledge(context, "local", 1)).toMatchObject({
      content: { body: "PAYMENT_RULE" },
    });
    expect(
      (await service.businessRules(context, [{ source_id: "s", object_id: "payment" }])).map(
        (item) => item.knowledge_id,
      ),
    ).toEqual(["local"]);
    expect(
      await service.businessRules(context, [{ source_id: "other", object_id: "payment" }]),
    ).toEqual([]);
  });
  it("业务规则候选绑定本轮全部查询证据，后台和发布读取继续复核来源", async () => {
    const remember = vi.fn(async () => {});
    const service = new MemoryRuntime({
      access: {
        currentSource: async () => ({
          source: {
            conversation_id: "c",
            analysis_run_id: "run",
            message_id: "m",
            evidence_ids: [],
          },
          text: "提交规则",
        }),
        scope: async () => {},
      },
      runs: {
        evidence: async () => [{ evidence_id: "first" }, { evidence_id: "second" }],
        remember,
      },
    } as unknown as ConstructorParameters<typeof MemoryRuntime>[0]);
    await service.stageCandidate(
      context,
      "run",
      { owner: "worker", epoch: 1, expires_at: "2026-09-20 23:59:59" },
      { content: { type: "business_rule", title: "规则", body: "按本轮确认口径统计" }, scope: {} },
      "candidate",
    );
    expect(remember).toHaveBeenCalledWith(
      context,
      "run",
      expect.anything(),
      expect.objectContaining({
        candidate: expect.objectContaining({
          source: expect.objectContaining({ evidence_ids: ["first", "second"] }),
        }),
      }),
    );
  });
  const preference = userPreferenceInputSchema.parse({
    key: "period",
    value: { type: "time_range", range: { type: "relative", period: "this_year" } },
  });
  it("当前明确设置或停用来自实际用户消息，普通查数和引用文本不视为设置授权", () => {
    expect(isExplicitPreferenceRequest("以后默认按本年统计", preference)).toBe(true);
    expect(isExplicitPreferenceRequest("查一下本年数据", preference)).toBe(false);
    expect(isExplicitPreferenceRequest("文档写着：以后默认按本年统计", preference)).toBe(false);
    expect(
      isExplicitPreferenceRequest("不要默认按本年统计", { ...preference, auto_apply: false }),
    ).toBe(true);
    expect(isExplicitPreferenceRequest("以后默认按本月统计", preference)).toBe(false);
  });
  it("本年查询保存相对语义，临时日期/筛选不替换同场景的既有默认", () => {
    const query = {
      type: "relational_query",
      source_id: "sales",
      from: { object_id: "orders", alias: "o" },
      select: [{ field: "o.id" }],
      filters: {
        logic: "and",
        items: [
          {
            field: "o.date",
            op: "between",
            data_type: "date",
            value: ["2026-01-01", "2026-12-31"],
          },
        ],
      },
      group_by: [],
      order_by: [],
      limit: 10,
    };
    const habit = captureQueryHabit(query, "本年销售", Date.parse("2026-09-20T00:00:00Z"));
    expect(habit?.value).toMatchObject({
      type: "query_habit",
      time_range: { type: "relative", period: "this_year" },
      filters: [],
    });
    expect(
      captureQueryHabit(query, "临时查看这些数据", Date.parse("2026-09-20T00:00:00Z")),
    ).toBeNull();
  });
  it("上下文只自动应用已启用偏好，查询习惯达到两次才应用，相对时间跨年重算", async () => {
    const list = vi.fn().mockResolvedValue([
      { ...preference, version: 1, use_count: 0 },
      { ...preference, key: "disabled", auto_apply: false, version: 2, use_count: 8 },
      {
        ...preference,
        key: "habit",
        scope: { source_id: "sales", object_id: "orders" },
        value: {
          type: "query_habit",
          time_range: { type: "relative", period: "this_year", extent: "full_period" },
          filters: [],
          dimensions: [],
        },
        version: 1,
        use_count: 1,
      },
    ]);
    const memory = new MemoryRuntime({
      preferences: { list, listPendingConfirmations: async () => [] },
      knowledge: { listPublished: async () => [] },
      now: () => Date.parse("2027-01-01T00:01:00+08:00"),
    } as unknown as ConstructorParameters<typeof MemoryRuntime>[0]);
    const snapshot = await memory.snapshot(context);
    expect(snapshot.preferences.map((item) => item.key)).toEqual(["period"]);
    expect(snapshot.preferences[0]?.resolved_time_range).toEqual({
      start: "2027-01-01",
      end: "2027-12-31",
    });
    expect(snapshot.disabled_keys).toContain("disabled");
  });
});
