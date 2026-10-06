import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { reportDefinitionVersionSchema } from "@ai-data/contracts";
import { registerReportManagementRoutes } from "../../src/routes/report-management-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { context } from "../support/api-fixtures";

const record = reportDefinitionVersionSchema.parse({
  report_id: "report",
  version: 1,
  organization_id: "org",
  user_id: "user",
  created_at: "2026-09-21 10:00:00",
  definition: {
    title: "分析",
    queries: [
      {
        query_id: "q",
        query: {
          type: "relational_query",
          source_id: "s",
          from: { object_id: "visit", alias: "v" },
          select: [{ field: "v.id" }],
        },
      },
    ],
    presentation: [
      {
        section_id: "s",
        title: "结果",
        blocks: [{ block_id: "b", type: "table", title: "表", query_ids: ["q"] }],
      },
    ],
  },
});
const headers = { authorization: "Bearer report-token" };
function setup() {
  const definitions = {
    save: vi.fn(async () => record),
    get: vi.fn(async () => record),
    saveBlock: vi.fn(),
    getBlock: vi.fn(),
    listBlocks: vi.fn(async () => ({ items: [] })),
    listTemplates: vi.fn(async () => []),
  };
  const management = {
    list: vi.fn(async () => ({ items: [] })),
    versions: vi.fn(async () => ({ definitions: [], snapshots: [] })),
    share: vi.fn(),
    exportReport: vi.fn(),
    artifacts: vi.fn(async () => []),
    exportConversation: vi.fn(),
  };
  const auth = {
    loadContext: vi.fn(async () => context),
    refreshContext: vi.fn(async () => context),
  };
  const app = Fastify();
  registerContractErrorHandler(app);
  registerReportManagementRoutes(app, auth, {
    definitions,
    management,
    sharing: { get: vi.fn(), candidates: vi.fn() },
  });
  return { app, definitions, management, auth };
}

describe("报表统一定义HTTP入口", () => {
  it("读取、二次编辑及历史请求使用可信身份和固定版本", async () => {
    const h = setup();
    expect(
      (await h.app.inject({ url: "/reports/report/definition?version=1", headers })).statusCode,
    ).toBe(200);
    expect(h.definitions.get).toHaveBeenCalledWith(context, "report", 1);
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/reports/report/definition",
          headers,
          payload: { expected_version: 1, definition: record.definition },
        })
      ).statusCode,
    ).toBe(200);
    expect(h.definitions.save).toHaveBeenCalledWith(
      context,
      { definition: record.definition, shared_with: [] },
      "report",
      1,
    );
    expect((await h.app.inject({ url: "/reports/report/versions", headers })).statusCode).toBe(200);
    expect(h.auth.loadContext).toHaveBeenCalledWith("report-token");
    await h.app.close();
  });
  it("公共修改拒绝零基准及伪造组织或作者，列表拒绝未知分页字段", async () => {
    const h = setup();
    for (const extra of [
      { expected_version: 0 },
      { expected_version: 1, user_id: "other" },
      { expected_version: 1, organization_id: "other" },
    ]) {
      expect(
        (
          await h.app.inject({
            method: "PUT",
            url: "/reports/report/definition",
            headers,
            payload: { definition: record.definition, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(h.definitions.save).not.toHaveBeenCalled();
    expect((await h.app.inject({ url: "/report-blocks?limit=101", headers })).statusCode).toBe(400);
    await h.app.close();
  });
});
