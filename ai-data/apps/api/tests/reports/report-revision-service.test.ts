import { describe, expect, it, vi } from "vitest";
import { reportDefinitionSchema, reportDefinitionVersionSchema } from "@ai-data/contracts";
import { ReportRevisionService } from "../../src/reports/report-revision-service";
import { context } from "../support/api-fixtures";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type {
  ReportRevisionDependencies,
  ReportEditContext,
} from "../../src/reports/report-revision-types";
import { ApplicationError } from "../../src/errors/application-error";

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

function bindingFixture() {
  const target: ReportEditContext = {
    mode: "revision",
    report_id: "report",
    expected_version: 1,
    definition,
  };
  const get = vi.fn<ReportRevisionDependencies["repository"]["get"]>(async (identity) =>
    identity.userId === context.userId && identity.organizationId === context.organizationId
      ? target
      : null,
  );
  const save = vi.fn(),
    create = vi.fn(),
    execute = vi.fn();
  const definitions = { get: vi.fn(async () => version), save };
  const service = new ReportRevisionService({
    repository: { get, create },
    definitions,
    executions: { get: execute },
  } as unknown as ReportRevisionDependencies);
  return { service, get, save, create, execute, definitions };
}

describe("只读修订绑定", () => {
  it("核对作者和基准后只返回绑定，不写入或执行业务", async () => {
    const h = bindingFixture();
    expect(await h.service.binding(context, "report", "run")).toEqual({
      report_id: "report",
      analysis_run_id: "run",
      expected_version: 1,
    });
    expect(h.get).toHaveBeenCalledWith(context, "run");
    expect(h.definitions.get).toHaveBeenCalledWith(context, "report", 1);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { mode: "revision", report_id: "other", expected_version: 1 },
    { mode: "narrative", report_id: "report", expected_version: 1, execution_id: "execution" },
    { mode: "revision", report_id: "report", expected_version: 0 },
  ] as const)("拒绝缺失、串报表、说明或未建版本的任务 %j", async (target) => {
    const h = bindingFixture();
    h.get.mockResolvedValueOnce(target);
    await expect(h.service.binding(context, "report", "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.definitions.get).not.toHaveBeenCalled();
  });
  it.each([
    { ...context, userId: "other" },
    { ...context, organizationId: "other" },
  ])("按当前身份读取上下文 %j", async (identity) => {
    const h = bindingFixture();
    await expect(h.service.binding(identity, "report", "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.get).toHaveBeenCalledWith(identity, "run");
  });
  it("当前非作者或权限已失效不能恢复", async () => {
    const h = bindingFixture();
    h.definitions.get.mockResolvedValueOnce({ ...version, user_id: "other" });
    await expect(h.service.binding(context, "report", "run")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    h.definitions.get.mockRejectedValueOnce(new ApplicationError("NOT_FOUND", "定义不可见"));
    await expect(h.service.binding(context, "report", "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
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
