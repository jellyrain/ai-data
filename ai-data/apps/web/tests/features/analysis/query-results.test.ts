import { describe, expect, it } from "vitest";
import type { QueryEvidence, SseEvent } from "@ai-data/contracts";
import { queryDslSchema } from "@ai-data/contracts";
import { projectQueryResults } from "../../../src/features/analysis/models/query-results";
import {
  relatedToolEvidence,
  toolActivityLabel,
} from "../../../src/features/analysis/models/tool-activity";
import type { RunTimelineItem } from "../../../src/features/analysis/stores/run-timeline-types";

const columns = [{ name: "count", data_type: "integer" as const }];
const query = queryDslSchema.parse({
  type: "relational_query",
  source_id: "clinical",
  from: { object_id: "visits", alias: "v" },
  select: [{ field: "v.count" }],
});
const evidence = (id: string, call = "query"): QueryEvidence => ({
  evidence_id: id,
  tool_call_id: call,
  analysis_run_id: "run",
  organization_id: "org",
  user_id: "user",
  created_at: "2026-10-08 10:00:00",
  requested_query: query,
  authorized_query: query,
  output_masks: [],
  result: {
    columns,
    rows: [{ count: 18 }],
    row_count: 1,
    truncated: false,
    delivery: { status: "complete", total_row_count: 1 },
  },
});
const table = (sequence: number, id?: string): SseEvent => ({
  conversation_id: "conversation",
  analysis_run_id: "run",
  type: "table",
  sequence,
  lease_epoch: 1,
  evidence_id: id,
  columns,
  rows: [{ count: 10 }],
  result_row_count: 1,
});

describe("对话查询数据与工具依据", () => {
  it("同一证据的重复事件只呈现一份，读取完整证据后替换样本并保留次序", () => {
    const events = [table(1, "a"), table(2, "b"), table(3, "a")];
    const before = projectQueryResults(events, []);
    const after = projectQueryResults(events, [evidence("b"), evidence("a"), evidence("c")]);
    expect(before).toHaveLength(2);
    expect(after.map((item) => item.evidenceId)).toEqual(["a", "b", "c"]);
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.table.rows).toEqual([{ count: 18 }]);
    expect(after[0]?.evidence?.evidence_id).toBe("a");
  });
  it("无证据的旧表格仍可查看，重复回放按事件标识去重", () => {
    expect(projectQueryResults([table(1), table(1), table(2)], [])).toHaveLength(2);
  });
  it("状态文案区分执行、成功、失败与终态缺失结果，未知工具保留名称", () => {
    const tool = { kind: "tool", key: "1:tool:a", name: "query_metric" } as const;
    expect(toolActivityLabel(tool, false)).toBe("正在查询指标数据");
    expect(toolActivityLabel({ ...tool, success: true }, true)).toBe("已查询指标数据");
    expect(toolActivityLabel({ ...tool, success: false }, true)).toBe("查询指标数据未成功");
    expect(toolActivityLabel(tool, true)).toContain("结果未记录");
    expect(toolActivityLabel({ ...tool, name: "custom_tool", success: true }, true)).toContain(
      "custom_tool",
    );
  });
  it("多结果按明确证据 ID 关联；同名失败调用和缺少标识的历史调用不借用其他结果", () => {
    const tool: Extract<RunTimelineItem, { kind: "tool" }> = {
      kind: "tool",
      key: "1:tool:metric",
      name: "query_metric",
      callId: "metric",
      success: true,
      output: JSON.stringify({ evidence_ids: ["a", "b"] }),
    };
    const items = [evidence("a", "groups"), evidence("b", "total"), evidence("c", "other")];
    expect(relatedToolEvidence(tool, items).map((item) => item.evidence_id)).toEqual(["a", "b"]);
    expect(
      relatedToolEvidence({ ...tool, callId: "retry", output: "查询失败", success: false }, items),
    ).toEqual([]);
    expect(relatedToolEvidence({ ...tool, callId: undefined, output: "旧摘要" }, items)).toEqual(
      [],
    );
    expect(relatedToolEvidence({ ...tool, callId: "other", output: "旧摘要" }, items)).toEqual([
      items[2],
    ]);
  });
});
