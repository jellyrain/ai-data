import { describe, expect, it, vi } from "vitest";
import {
  queryEvidenceSchema,
  queryDslSchema,
  reportDefinitionVersionSchema,
  type ReportDefinitionVersion,
  type SavedReport,
} from "@ai-data/contracts";
import { ReportService } from "../../src/reports/report-service";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

function setup() {
  const query = queryDslSchema.parse({
    type: "relational_query",
    source_id: "clinical",
    from: { object_id: "visit", alias: "v" },
    select: [{ field: "v.id" }],
  });
  const source = queryEvidenceSchema.parse({
    evidence_id: "e",
    tool_call_id: "t",
    analysis_run_id: "run",
    organization_id: "org",
    user_id: "user",
    created_at: "2026-09-14 08:00:00",
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
  let saved: SavedReport | null = null;
  const authorize = vi.fn(async () => ({ request: { query, access: { output_masks: [] } } }));
  const completedSource = vi.fn(async () => [source]);
  const definitionHead = vi.fn(async (): Promise<ReportDefinitionVersion | null> => null);
  const service = new ReportService(
    {
      transaction: async (operation) => operation({ execute: vi.fn() }),
      find: async () => saved,
      save: async (_context, input, reportId, expectedVersion) => {
        saved = { ...input, report_id: reportId ?? "report", version: (expectedVersion ?? 0) + 1 };
        return saved;
      },
    },
    { evidence: async () => [source] },
    { authorize } as unknown as ConstructorParameters<typeof ReportService>[2],
    {
      source: completedSource,
      assertActiveUsers: vi.fn(async () => undefined),
      findDefinitionHead: definitionHead,
    },
  );
  const input = {
    analysis_run_id: "run",
    title: "就诊分析",
    sections: [
      {
        section_id: "s",
        title: "统计",
        blocks: [{ block_id: "b", type: "table", title: "人数", evidence_ids: ["e"] }],
      },
    ],
    shared_with: ["reader"],
  };
  return { service, source, input, authorize, completedSource, definitionHead };
}

describe("报告证据与读取权限", () => {
  it("共享用户执行产生的快照继续使用定义作者的最新 ACL", async () => {
    const h = setup();
    const snapshot = await h.service.save({ ...context, userId: "reader" }, h.input);
    const head = reportDefinitionVersionSchema.parse({
      report_id: snapshot.report_id,
      version: 1,
      organization_id: "org",
      user_id: "user",
      created_at: "2026-09-21 08:00:00",
      shared_with: ["reader"],
      definition: {
        title: "分析",
        queries: [{ query_id: "q", query: h.source.requested_query }],
        presentation: [
          {
            section_id: "s",
            title: "结果",
            blocks: [{ block_id: "b", type: "table", title: "表", query_ids: ["q"] }],
          },
        ],
      },
    });
    h.definitionHead.mockResolvedValue(head);
    await expect(h.service.get(context, snapshot.report_id)).resolves.toMatchObject({
      user_id: "reader",
    });
    h.definitionHead.mockResolvedValue({ ...head, version: 2, shared_with: [] });
    await expect(
      h.service.get({ ...context, userId: "reader" }, snapshot.report_id, 1),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("公共保存和读取均拒绝尚未成功完成的来源运行", async () => {
    const h = setup();
    h.completedSource.mockRejectedValueOnce(new ApplicationError("CONFLICT", "运行未完成"));
    await expect(h.service.save(context, h.input)).rejects.toMatchObject({ code: "CONFLICT" });
    const report = await h.service.save(context, h.input);
    h.completedSource.mockRejectedValueOnce(new ApplicationError("CONFLICT", "运行未完成"));
    await expect(h.service.get(context, report.report_id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("保存完整来源快照，具有相同数据权限的分享对象可读取", async () => {
    const h = setup();
    const saved = await h.service.save(context, h.input);
    expect(saved.sources).toEqual([h.source]);
    expect((await h.service.get({ ...context, userId: "reader" }, saved.report_id)).report_id).toBe(
      saved.report_id,
    );
    await expect(
      h.service.get({ ...context, userId: "stranger" }, saved.report_id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("当前行权限与快照不一致时整份报告拒绝读取", async () => {
    const h = setup();
    const saved = await h.service.save(context, h.input);
    h.authorize.mockRejectedValue(new Error("权限已收回"));
    await expect(h.service.get(context, saved.report_id)).rejects.toThrow();
  });
  it("不存在的证据及图表坐标不能写入报告", async () => {
    const h = setup();
    const input = structuredClone(h.input);
    input.sections[0].blocks[0].evidence_ids = ["missing"];
    await expect(h.service.save(context, input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      h.service.save(context, {
        ...h.input,
        sections: [
          {
            section_id: "s",
            title: "图",
            blocks: [
              {
                block_id: "b",
                type: "chart",
                title: "图",
                evidence_ids: ["e"],
                chart: { type: "bar", x: "id", y: "missing" },
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
