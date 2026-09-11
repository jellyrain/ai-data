import { describe, expect, it } from "vitest";

import { sseEventSchema } from "../../src/sse/sse-events";

const baseEvent = {
  conversation_id: "conversation-001",
  analysis_run_id: "run-001",
  sequence: 0,
};

describe("SSE 事件合同", () => {
  // BDD 场景：服务端推送所有支持的流式事件；TDD 断言：每种事件变体都能通过联合合同。
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

  // BDD 场景：客户端收到未知事件或负序号；TDD 断言：联合类型和公共字段校验必须失败。
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

  // BDD 场景：澄清事件返回空选项 ID；TDD 断言：前端选项必须具备非空标识。
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
