import { describe, expect, it, vi } from "vitest";
import { savedReportSchema } from "@ai-data/contracts";
import { ReportManagementService } from "../../src/reports/report-management-service";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

const report = savedReportSchema.parse({
  report_id: "a",
  version: 1,
  organization_id: "org",
  user_id: "user",
  created_at: "2026-09-21 10:00:00",
  analysis_run_id: "run",
  title: "就诊分析",
  shared_with: [],
  sections: [
    {
      section_id: "s",
      title: "结果",
      blocks: [{ block_id: "b", type: "table", title: "人数", evidence_ids: ["e"] }],
    },
  ],
  sources: [
    {
      evidence_id: "e",
      tool_call_id: "t",
      analysis_run_id: "run",
      organization_id: "org",
      user_id: "user",
      created_at: "2026-09-21 10:00:00",
      requested_query: {
        type: "relational_query",
        source_id: "s",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id" }],
      },
      authorized_query: {
        type: "relational_query",
        source_id: "s",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id" }],
      },
      output_masks: [],
      result: {
        columns: [{ name: "id", data_type: "integer" }],
        rows: [{ id: 1 }],
        row_count: 1,
        truncated: true,
      },
    },
  ],
});

function setup() {
  const get = vi.fn(async (_context, id: string) => {
    if (id === "hidden") throw new ApplicationError("POLICY_REJECTED", "来源权限不足");
    return { ...report, report_id: id };
  });
  const source = vi.fn(async () => report.sources);
  const service = new ReportManagementService({
    repository: {
      listReportIds: async (_org, after) => (after ? [] : ["a", "hidden", "z"]),
      snapshotVersions: async () => [1],
      artifacts: async () => [{ artifact_id: "artifact", report }],
    },
    reports: { get, share: vi.fn() },
    definitions: {
      get: vi.fn(async () => {
        throw new ApplicationError("NOT_FOUND", "无定义");
      }),
      versions: vi.fn(async () => []),
      share: vi.fn(),
    },
    source,
    runs: {
      get: vi.fn(async () => ({ status: "completed" as const })),
      evidence: vi.fn(async () => report.sources),
    },
    conversations: {
      get: vi.fn(async () => ({
        conversation: { id: "c", title: "对话" },
        messages: [
          {
            id: "u",
            role: "user" as const,
            content: "查询",
            sequence: 1,
            createdAt: new Date("2026-09-21T02:00:00Z"),
            conversationId: "c",
          },
          {
            id: "a",
            role: "assistant" as const,
            content: "分析完成",
            sequence: 2,
            analysisRunId: "run",
            createdAt: new Date("2026-09-21T02:01:00Z"),
            conversationId: "c",
          },
        ],
      })),
    },
  });
  return { service, get, source };
}

describe("报表列表、产物和导出内容", () => {
  it("卡片摘要从授权快照提供类型和更新时间，不交付结果内容", async () => {
    const page = await setup().service.list(context);
    expect(page.items[0]).toMatchObject({ display_type: "table", updated_at: report.created_at });
    expect(page.items[0]).not.toHaveProperty("sources");
  });
  it("列表过滤来源权限不足的全部摘要，游标按最后返回项推进", async () => {
    const h = setup();
    const page = await h.service.list(context, { limit: 1 });
    expect(page.items.map((item) => item.report_id)).toEqual(["a"]);
    expect(page.next_cursor).toBe("a");
    const all = await h.service.list(context);
    expect(all.items.map((item) => item.report_id)).toEqual(["a", "z"]);
  });
  it("导出固定快照标记截断并保留已保存结果", async () => {
    const h = setup();
    const result = await h.service.exportReport(context, "a", 1);
    expect(result.tables[0].availability).toBe("truncated");
    expect(result.report.sources[0].result.rows).toEqual([{ id: 1 }]);
    expect(h.get).toHaveBeenCalledWith(context, "a", 1);
  });
  it("未完成运行的产物不公开，完成后的会话按消息顺序导出", async () => {
    const h = setup();
    h.source.mockRejectedValueOnce(new ApplicationError("CONFLICT", "运行未完成"));
    await expect(h.service.artifacts(context, "run")).rejects.toMatchObject({ code: "CONFLICT" });
    const output = await h.service.exportConversation(context, "c");
    expect(output.messages.map((item) => item.message_id)).toEqual(["u", "a"]);
    expect(output.artifacts).toHaveLength(1);
    expect(output.tables[0].availability).toBe("truncated");
  });
});
