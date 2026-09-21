import Fastify from "fastify";
import dayjs from "dayjs";
import { describe, expect, it, vi } from "vitest";
import { metricDefinitionSchema } from "@ai-data/contracts";
import { registerKnowledgeRoutes } from "../../src/routes/knowledge-routes";
import { registerMetricReportRoutes } from "../../src/routes/metric-report-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { MemoryKnowledgeRepository } from "../knowledge/memory-knowledge-repository";
import { createApiDependencies } from "../support/api-fixtures";

const headers = { authorization: "Bearer test" };
const input = {
  idempotency_key: "rule",
  content: { type: "business_rule", title: "人次规则", body: "按就诊日期统计" },
  scope: {},
};
const metric = metricDefinitionSchema.parse({
  metric_id: "visits",
  version: 1,
  name: "就诊",
  description: "按就诊日期",
  aliases: [],
  grain: "就诊",
  deduplication_keys: ["v.id"],
  date_basis: { field: "v.date", data_type: "date" },
  dimensions: [],
  total_rule: "recalculate",
  value: { type: "column", column: "value" },
  query: {
    type: "relational_query",
    source_id: "clinical",
    from: { object_id: "visits", alias: "v" },
    select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
  },
});
function setup() {
  const dependencies = createApiDependencies();
  const context = {
    userId: "admin",
    organizationId: "org",
    sessionId: "s",
    roles: ["system_admin"],
    permissions: [],
    dataPolicies: [],
  };
  dependencies.auth.loadContext.mockResolvedValue(context);
  const repository = new MemoryKnowledgeRepository();
  const service = new KnowledgeService({
    repository,
    metrics: { validateDefinition: vi.fn(async () => {}) },
    authorizeScope: vi.fn(async () => {}),
    validateSource: vi.fn(async () => {}),
    now: () => dayjs("2026-09-20T02:00:00Z").toDate(),
  });
  const app = Fastify();
  registerContractErrorHandler(app);
  registerKnowledgeRoutes(app, dependencies.auth, service);
  registerMetricReportRoutes(app, dependencies.auth, dependencies.analysis, service);
  return { app, service, repository, dependencies, context };
}
describe("知识审核 HTTP 与指标候选入口", () => {
  it("提交、分配、审核和发布按身份完成闭环，停用后正式读取返回 404", async () => {
    const { app, dependencies } = setup();
    try {
      const submitted = await app.inject({
        method: "POST",
        url: "/knowledge-candidates",
        headers,
        payload: input,
      });
      expect(submitted.statusCode).toBe(201);
      const candidate = submitted.json();
      expect(candidate.status).toBe("pending");
      expect((await app.inject({ url: "/knowledge", headers })).json()).toEqual({ items: [] });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/admin/knowledge-candidates/${candidate.candidate_id}/owner`,
            headers,
            payload: { owner_id: "owner", expected_version: 1 },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/admin/knowledge-candidates/${candidate.candidate_id}/review`,
            headers,
            payload: { expected_version: 1, decision: "approve", comment: "通过" },
          })
        ).statusCode,
      ).toBe(200);
      const published = await app.inject({
        method: "POST",
        url: `/admin/knowledge-candidates/${candidate.candidate_id}/publish`,
        headers,
        payload: { expected_version: 1, effective_at: "2026-09-20 10:00:00" },
      });
      expect(published.statusCode).toBe(201);
      expect(
        (
          await app.inject({ url: `/knowledge/${candidate.knowledge_id}?version=1`, headers })
        ).json().version,
      ).toBe(1);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/admin/knowledge/${candidate.knowledge_id}/enabled`,
            headers,
            payload: { enabled: false },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await app.inject({ url: `/knowledge/${candidate.knowledge_id}`, headers })).statusCode,
      ).toBe(404);
      expect(dependencies.auth.loadContext).toHaveBeenCalledWith("test");
    } finally {
      await app.close();
    }
  });
  it("既有指标管理 POST 只返回 pending 候选，正式指标读取调用独立服务", async () => {
    const { app, repository, dependencies, context } = setup();
    dependencies.analysis.metrics.list.mockResolvedValue([] as never);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/metrics",
        headers,
        payload: metric,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        status: "pending",
        knowledge_id: "visits",
        content: { type: "metric", definition: metric },
      });
      expect(repository.versions.size).toBe(0);
      expect((await app.inject({ url: "/metrics", headers })).json()).toEqual({ items: [] });
      expect(dependencies.analysis.metrics.list).toHaveBeenCalledWith(context);
    } finally {
      await app.close();
    }
  });
  it("未知字段、伪造组织、错误版本与缺少身份在边界拒绝", async () => {
    const { app } = setup();
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/knowledge-candidates",
            headers,
            payload: { ...input, organization_id: "other" },
          })
        ).statusCode,
      ).toBe(400);
      expect((await app.inject({ url: "/knowledge/id?version=0", headers })).statusCode).toBe(400);
      expect(
        (await app.inject({ url: "/knowledge?organization_id=other", headers })).statusCode,
      ).toBe(400);
      expect((await app.inject({ url: "/knowledge" })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/knowledge-candidates/id/owner",
            headers,
            payload: { owner_id: "owner", expected_version: 1, organization_id: "other" },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
