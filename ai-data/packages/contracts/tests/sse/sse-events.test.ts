import { describe, expect, it } from "vitest";

import { sseEventSchema } from "../../src/sse/sse-events";

const baseEvent = {
  conversation_id: "conversation-001",
  analysis_run_id: "run-001",
  sequence: 0,
};

// 所有变体复用相同的会话、运行和序号；这些用例检查载荷结构，事件写入负责运行内排序。
describe("SSE 事件合同", () => {
  it("压缩事件关联条目并校验状态与真实业务时间", () => {
    const event = {
      ...baseEvent,
      type: "context_compaction",
      item_id: "compact-1",
      status: "started",
      occurred_at: "2026-09-15 16:00:00",
    };
    expect(sseEventSchema.safeParse(event).success).toBe(true);
    expect(sseEventSchema.safeParse({ ...event, status: "completed" }).success).toBe(true);
    expect(sseEventSchema.safeParse({ ...event, status: "unknown" }).success).toBe(false);
    expect(sseEventSchema.safeParse({ ...event, item_id: "" }).success).toBe(false);
    expect(sseEventSchema.safeParse({ ...event, occurred_at: "2026-02-30 16:00:00" }).success).toBe(
      false,
    );
  });
  it("拒绝事件根对象的未知字段", () => {
    expect(
      sseEventSchema.safeParse({ ...baseEvent, type: "run_started", extra: true }).success,
    ).toBe(false);
  });

  it.each([
    { columns: [{ name: "id", data_type: "integer" }], rows: [{ id: "12" }] },
    { columns: [{ name: "id", data_type: "integer" }], rows: [{ id: 12, extra: 1 }] },
    { columns: [{ name: "id", data_type: "integer" }], rows: [{}] },
    {
      columns: [
        { name: "id", data_type: "integer" },
        { name: "id", data_type: "integer" },
      ],
      rows: [],
    },
  ])("表格事件复用列与结果行一致性约束 %#", (table) => {
    expect(sseEventSchema.safeParse({ ...baseEvent, type: "table", ...table }).success).toBe(false);
  });
  it("接受所有支持的事件类型", () => {
    const events = [
      { ...baseEvent, type: "run_started" },
      { ...baseEvent, type: "progress", message: "正在查询" },
      {
        ...baseEvent,
        type: "thinking",
        stage: "planning",
        content: "正在确定统计时间字段和聚合维度。",
      },
      {
        ...baseEvent,
        type: "tool_call",
        tool_name: "search_catalog",
        input_summary: "搜索门诊人次",
      },
      {
        ...baseEvent,
        type: "tool_result",
        tool_name: "search_catalog",
        success: true,
        output_summary: "找到 2 个数据集",
      },
      {
        ...baseEvent,
        type: "clarification",
        question: "按入院时间还是出院时间统计？",
        options: [
          { id: "admission_time", label: "入院时间" },
          { id: "discharge_time", label: "出院时间" },
        ],
        allow_custom_input: false,
      },
      { ...baseEvent, type: "final_answer", content: "本月门诊人次为 1000。" },
      {
        ...baseEvent,
        type: "table",
        columns: [{ name: "visit_count", data_type: "integer" }],
        rows: [{ visit_count: 1000 }],
      },
      {
        ...baseEvent,
        type: "chart",
        chart_type: "bar",
        spec: { x: "department", y: "visit_count" },
      },
      { ...baseEvent, type: "run_completed" },
      { ...baseEvent, type: "run_failed", code: "QUERY_FAILED", message: "查询失败" },
      { ...baseEvent, type: "run_cancelled" },
    ];

    for (const event of events) {
      expect(sseEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("拒绝未知事件类型和非法公共字段", () => {
    expect(sseEventSchema.safeParse({ ...baseEvent, type: "unknown" }).success).toBe(false);

    expect(
      sseEventSchema.safeParse({
        ...baseEvent,
        sequence: -1,
        type: "run_started",
      }).success,
    ).toBe(false);
  });

  it("要求选项具有有效标识", () => {
    expect(
      sseEventSchema.safeParse({
        ...baseEvent,
        type: "clarification",
        question: "请选择时间字段",
        options: [{ id: "", label: "入院时间" }],
        allow_custom_input: false,
      }).success,
    ).toBe(false);
  });
});
