import { describe, expect, it, vi } from "vitest";
import { savedReportSchema } from "@ai-data/contracts";
import { ReportManagementService } from "../../src/reports/report-management-service";
import { ApplicationError } from "../../src/errors/application-error";
import type { AuthContext } from "../../src/auth/auth-types";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import type {
  CatalogPermissionRepository,
  RawCatalogReader,
} from "../../src/catalog/catalog-types";
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

function setup(authorize?: (context: AuthContext) => Promise<void>) {
  const get = vi.fn(async (context: AuthContext, id: string) => {
    await authorize?.(context);
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

/** 目录替身仅提供数据，合并权限和请求复用走正式服务实现。 */
function catalogSetup() {
  const raw = {
    listRawCatalog: vi.fn<RawCatalogReader["listRawCatalog"]>(async (sourceId) => [
      {
        source_id: sourceId,
        object_id: "visit",
        name: "visit",
        kind: "table",
        columns: [
          { name: "id", data_type: "integer", nullable: false },
          { name: "name", data_type: "string", nullable: false },
        ],
        query_parameters: [],
      },
    ]),
  };
  const config = {
    find: async () => null,
    listBySourceId: vi.fn(async () => []),
    save: async () => {},
  };
  const permissions = {
    listObjectPermissions: vi.fn<CatalogPermissionRepository["listObjectPermissions"]>(async () => [
      { role_id: "reader", object_id: "visit", effect: "allow" },
    ]),
    listColumnPermissions: vi.fn<CatalogPermissionRepository["listColumnPermissions"]>(async () => [
      { role_id: "reader", object_id: "visit", column: "name", effect: "deny" },
    ]),
    listRowPolicies: vi.fn(async () => []),
    saveObjectPermission: async () => {},
    saveColumnPermission: async () => {},
    saveRowPolicy: async () => {},
  };
  return {
    raw,
    config,
    permissions,
    catalog: new BusinessCatalogService(raw, config, permissions),
  };
}

describe("报表列表的目录读取范围", () => {
  it("同一次列表中逐报表校验权限，同一数据源的并发和重复读取只发现一次目录", async () => {
    const c = catalogSetup();
    const authorize = vi.fn(async (identity: AuthContext) => {
      const items = await Promise.all([
        c.catalog.getAuthorized(identity, "s", "visit"),
        c.catalog.getAuthorized(identity, "s", "visit"),
      ]);
      expect(items.every((item) => item?.dataset.object_id === "visit")).toBe(true);
    });
    const page = await setup(authorize).service.list(context);
    expect(page.items.map((item) => item.report_id)).toEqual(["a", "z"]);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(1);
    expect(c.permissions.listObjectPermissions).toHaveBeenCalledTimes(1);
  });

  it("下一次列表重新读取权限，撤销对象访问后不再返回卡片", async () => {
    const c = catalogSetup();
    const reader = { ...context, roles: ["reader"], roleIds: ["reader"] };
    const h = setup(async (identity) => {
      const item = await c.catalog.getAuthorized(identity, "s", "visit");
      if (!item) throw new ApplicationError("POLICY_REJECTED", "来源权限不足");
      expect(item.dataset.columns.map((column) => column.name)).toEqual(["id"]);
    });
    expect((await h.service.list(reader)).items).toHaveLength(2);
    c.permissions.listObjectPermissions.mockResolvedValue([]);
    expect((await h.service.list(reader)).items).toEqual([]);
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(2);
  });

  it("并发列表分别读取目录，管理员与无权限用户的结果互不复用", async () => {
    const c = catalogSetup();
    const h = setup(async (identity) => {
      if (!(await c.catalog.getAuthorized(identity, "s", "visit")))
        throw new ApplicationError("POLICY_REJECTED", "来源权限不足");
    });
    const [first, second, denied] = await Promise.all([
      h.service.list(context),
      h.service.list(context),
      h.service.list({ ...context, userId: "other", roles: [], roleIds: [] }),
    ]);
    expect(first.items).toHaveLength(2);
    expect(second).toEqual(first);
    expect(denied.items).toEqual([]);
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(3);
  });

  it("同一读取范围内也按身份、授权上下文、数据源和目录服务隔离", async () => {
    const c = catalogSetup();
    const other = catalogSetup();
    const h = setup(async (identity) => {
      const reader = { ...identity, roles: ["reader"], roleIds: ["reader"] };
      expect((await c.catalog.getAuthorized(identity, "s", "visit"))?.dataset.columns).toHaveLength(
        2,
      );
      expect((await c.catalog.getAuthorized(reader, "s", "visit"))?.dataset.columns).toHaveLength(
        1,
      );
      expect(await c.catalog.getAuthorized({ ...reader, roleIds: [] }, "s", "visit")).toBeNull();
      expect((await c.catalog.getAuthorized(identity, "other", "visit"))?.dataset.source_id).toBe(
        "other",
      );
      await c.catalog.getAuthorized({ ...identity, organizationId: "other-org" }, "s", "visit");
      await c.catalog.getAuthorized({ ...identity, userId: "other-user" }, "s", "visit");
      await other.catalog.getAuthorized(identity, "s", "visit");
    });
    await h.service.list(context);
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(6);
    expect(other.raw.listRawCatalog).toHaveBeenCalledTimes(1);
  });

  it("目录读取失败后可重读，失败请求结束后下一次列表重新读取", async () => {
    const c = catalogSetup();
    c.raw.listRawCatalog.mockRejectedValueOnce(new ApplicationError("CONFLICT", "目录变更"));
    const h = setup(async (identity) => {
      await c.catalog.getAuthorized(identity, "s", "visit");
    });
    expect((await h.service.list(context)).items.map((item) => item.report_id)).toEqual(["z"]);
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(2);
    c.raw.listRawCatalog.mockRejectedValueOnce(new Error("DAS unavailable"));
    await expect(h.service.list(context)).rejects.toThrow("DAS unavailable");
    expect((await h.service.list(context)).items).toHaveLength(2);
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(4);
  });

  it("调用方修改返回目录不影响后续报表，列表之外的读取仍获取最新目录", async () => {
    const c = catalogSetup();
    const h = setup(async (identity) => {
      const item = (await c.catalog.getAuthorized(identity, "s", "visit"))!;
      expect(item.dataset.columns).toHaveLength(2);
      item.dataset.columns.length = 0;
    });
    await h.service.list(context);
    await c.catalog.listAuthorized(context, "s");
    await c.catalog.listAuthorized(context, "s");
    expect(c.raw.listRawCatalog).toHaveBeenCalledTimes(3);
  });
});
