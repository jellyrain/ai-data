import { describe, expect, it, vi } from "vitest";
import { reportDefinitionSchema, reportDefinitionVersionSchema } from "@ai-data/contracts";
import { ReportRevisionService } from "../../src/reports/report-revision-service";
import { context } from "../support/api-fixtures";
import type { MetadataQueryExecutor } from "@ai-data/metadata";

const definition = reportDefinitionSchema.parse({
  title: "报表",
  queries: [
    {
      query_id: "q",
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
      section_id: "s",
      title: "表",
      blocks: [{ block_id: "b", type: "table", title: "表", query_ids: ["q"] }],
    },
  ],
});
const version = reportDefinitionVersionSchema.parse({
  definition,
  report_id: "report",
  version: 1,
  organization_id: "org",
  user_id: "user",
  created_at: "2026-09-21 08:00:00",
});
describe("对话报表修改提交", () => {
  it("工具暂存定义，只有成功终态才调用相同保存服务", async () => {
    const edit = { mode: "revision", report_id: "report", expected_version: 1, definition };
    const stage = vi.fn(async () => {}),
      save = vi.fn(async () => version);
    const repository = {
      get: vi.fn(async () => edit),
      stage,
      staged: vi.fn(async () => ({ ...definition, title: "更新" })),
      create: vi.fn(),
      initialize: vi.fn(),
    };
    const service = new ReportRevisionService({
      repository,
      definitions: { get: async () => version, save },
      validate: vi.fn(async () => {}),
      runs: {
        withLease: async (
          _ctx: unknown,
          _run: string,
          _lease: unknown,
          operation: (executor: MetadataQueryExecutor) => Promise<unknown>,
        ) => operation({} as MetadataQueryExecutor),
      },
    } as unknown as ConstructorParameters<typeof ReportRevisionService>[0]);
    await service.stage(
      context,
      "run",
      { owner: "worker", epoch: 1, expires_at: "2099-01-01 00:00:00" },
      { definition: { ...definition, title: "更新" } },
    );
    expect(stage).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await service.complete(context, "run", {} as MetadataQueryExecutor, "完成");
    expect(save).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ definition: expect.objectContaining({ title: "更新" }) }),
      "report",
      1,
      expect.anything(),
    );
  });
  it("已绑定报表的工具不能改写另一报表", async () => {
    const stage = vi.fn();
    const service = new ReportRevisionService({
      repository: {
        get: async () => ({
          mode: "revision",
          report_id: "report",
          expected_version: 1,
          definition,
        }),
        stage,
      },
      definitions: { get: async () => version },
      runs: {
        withLease: async (
          _ctx: unknown,
          _run: string,
          _lease: unknown,
          operation: (executor: MetadataQueryExecutor) => Promise<unknown>,
        ) => operation({} as MetadataQueryExecutor),
      },
    } as unknown as ConstructorParameters<typeof ReportRevisionService>[0]);
    await expect(
      service.stage(
        context,
        "run",
        { owner: "worker", epoch: 1, expires_at: "2099-01-01 00:00:00" },
        { definition, report_id: "other" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(stage).not.toHaveBeenCalled();
  });
});
