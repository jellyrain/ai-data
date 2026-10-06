import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  metricDefinitionSchema,
  type KnowledgeCandidate,
  type MetricDefinition,
} from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import type { AuthContext } from "../../src/auth/auth-types";
import { KnowledgeService } from "../../src/knowledge/knowledge-service";
import { SqlKnowledgeRepository } from "../../src/knowledge/sql-knowledge-repository";
import { SqlMetricRepository } from "../../src/metrics/sql-metric-repository";
import { ApplicationError } from "../../src/errors/application-error";

const author: AuthContext = {
  userId: "author",
  organizationId: "org",
  sessionId: "session",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
const owner = { ...author, userId: "owner" };
const manager = { ...author, userId: "manager", permissions: ["knowledge:manage"] };
const administrator = { ...author, userId: "admin", roles: ["system_admin"] };
const definition = metricDefinitionSchema.parse({
  metric_id: "visits",
  version: 1,
  name: "就诊",
  description: "按就诊日期",
  aliases: [],
  grain: "就诊",
  deduplication_keys: ["v.id"],
  date_basis: { field: "v.visited_on", data_type: "date" },
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

describe("SQL Server：企业知识审核、发布与指标有效版本", () => {
  const name = "ai_data_knowledge_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let created = false;
  let repository: SqlKnowledgeRepository;
  let service: KnowledgeService;
  let metrics: SqlMetricRepository;
  const now = () => dayjs("2026-09-20T02:00:00Z").toDate();
  beforeAll(async () => {
    const raw = JSON.parse(
      readFileSync(
        process.env.SQLSERVER_TEST_CONFIG ??
          fileURLToPath(new URL("../../config/api.config.json", import.meta.url)),
        "utf8",
      ),
    );
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(
      raw.metadata_sqlserver ?? raw,
    );
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({
      ...connection,
      database: name,
      options: { ...connection.options, pool: { ...connection.options.pool, max: 1, min: 0 } },
    });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await new SqlAuthRepository(database).ensureBootstrapAdmin({
      userId: "admin",
      organizationId: "org",
      organizationCode: "knowledge",
      organizationName: "知识测试",
      username: "admin",
      displayName: "管理员",
      passwordHash: "test-hash",
    });
    await database.execute({
      sql: "INSERT INTO dbo.users(id,organization_id,username,display_name,status) VALUES('author','org','author',N'提交者','active'),('owner','org','owner',N'负责人','active'),('manager','org','manager',N'知识管理员','active'),('disabled','org','disabled',N'停用用户','disabled')",
      parameters: [],
    });
    repository = new SqlKnowledgeRepository(database);
    service = new KnowledgeService({
      repository,
      metrics: {
        validateDefinition: async (_context, _metric, executor) => {
          if (executor) await executor.execute({ sql: "SELECT 1 AS healthy", parameters: [] });
        },
      },
      authorizeScope: async (context, scope, executor) => {
        if (context.userId === "revoked" || scope.source_id === "secret")
          throw new ApplicationError("UNAUTHORIZED_OBJECT", "无权访问来源");
        if (executor) await executor.execute({ sql: "SELECT 1 AS healthy", parameters: [] });
      },
      validateSource: async (context, source, executor) => {
        if (source.analysis_run_id === "private" && context.userId !== "author")
          throw new ApplicationError("UNAUTHORIZED", "来源无权访问");
        if (executor) await executor.execute({ sql: "SELECT 1 AS healthy", parameters: [] });
      },
      now,
    });
    metrics = new SqlMetricRepository(database, now);
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_knowledge_test_[a-f0-9]{32}$/.test(name))
          throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  async function submitRule(
    body: string = randomUUID(),
    source?: { analysis_run_id: string; evidence_ids: string[] },
  ) {
    return service.submit(author, {
      idempotency_key: randomUUID(),
      content: { type: "business_rule", title: "规则", body },
      scope: { source_id: "clinical", object_id: "visits" },
      source,
    });
  }
  async function approve(candidate: KnowledgeCandidate) {
    await service.assignOwner(manager, candidate.candidate_id, "owner", candidate.version);
    return service.review(owner, candidate.candidate_id, {
      expected_version: candidate.version,
      decision: "approve",
      comment: "审核通过",
    });
  }
  async function publishMetric(metric: MetricDefinition, effective_at = "2026-09-01 00:00:00") {
    const candidate = await service.submitMetric(administrator, metric);
    await approve(candidate);
    return service.publish(owner, candidate.candidate_id, {
      expected_version: candidate.version,
      effective_at,
    });
  }
  it("并发规范化提交、审核与发布只形成一份正式版本，重试幂等", async () => {
    const [first, second] = await Promise.all([
      submitRule("并发规则"),
      submitRule(" 并发规则\r\n"),
    ]);
    expect(second.candidate_id).toBe(first.candidate_id);
    await service.assignOwner(manager, first.candidate_id, "owner", 1);
    const reviewed = await Promise.all([
      service.review(owner, first.candidate_id, {
        expected_version: 1,
        decision: "approve",
        comment: "同意",
      }),
      service.review(owner, first.candidate_id, {
        expected_version: 1,
        decision: "approve",
        comment: "同意",
      }),
    ]);
    expect(reviewed.every((item) => item.status === "approved")).toBe(true);
    const versions = await Promise.all([
      service.publish(owner, first.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-01 00:00:00",
      }),
      service.publish(owner, first.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-01 00:00:00",
      }),
    ]);
    expect(versions.map((item) => item.version)).toEqual([1, 1]);
    expect(await repository.listReviews("org", first.candidate_id)).toHaveLength(1);
    expect(await repository.listSources("org", first.candidate_id)).toHaveLength(1);
  });
  it("管理权限可以分配负责人，代审仅系统管理员，编辑使旧审核失效", async () => {
    const candidate = await submitRule();
    await expect(
      service.assignOwner(manager, candidate.candidate_id, "disabled", 1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await approve(candidate);
    await expect(
      service.review(manager, candidate.candidate_id, {
        expected_version: 1,
        decision: "approve",
        comment: "代审",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      service.publish({ ...owner, organizationId: "other" }, candidate.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-01 00:00:00",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await service.update(author, candidate.candidate_id, {
      expected_version: 1,
      content: { type: "business_rule", title: "更新", body: "内容更新" },
      scope: candidate.scope,
    });
    await expect(
      service.publish(owner, candidate.candidate_id, {
        expected_version: 1,
        effective_at: "2026-09-01 00:00:00",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await repository.listReviews("org", candidate.candidate_id))[0].candidate.content,
    ).toEqual(candidate.content);
  });
  it("外层单连接事务原子保存候选和副作用，异常全部回滚", async () => {
    const input = {
      idempotency_key: "external-transaction",
      content: { type: "business_rule" as const, title: "事务", body: "事务规则" },
      scope: {},
    };
    await expect(
      database.transaction(async (executor) => {
        await service.submit(author, input, executor);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      (
        await database.execute({
          sql: "SELECT COUNT(*) AS count FROM dbo.knowledge_operations WHERE idempotency_key='external-transaction'",
          parameters: [],
        })
      ).rows,
    ).toEqual([{ count: 0 }]);
    const candidate = await database.transaction((executor) =>
      service.submit(author, input, executor),
    );
    expect((await service.submit(author, input)).candidate_id).toBe(candidate.candidate_id);
  });
  it("未审和未来指标不可读取，发布后历史、停用、回滚均选择正式版本", async () => {
    const candidate = await service.submitMetric(administrator, definition);
    expect(await metrics.find("org", "visits")).toBeNull();
    await approve(candidate);
    await service.publish(owner, candidate.candidate_id, {
      expected_version: 1,
      effective_at: "2026-09-01 00:00:00",
    });
    await publishMetric({ ...definition, version: 2, name: "未来版本" }, "2026-10-01 00:00:00");
    expect((await metrics.find("org", "visits"))?.version).toBe(1);
    expect(await metrics.find("org", "visits", 2)).toBeNull();
    await service.setEnabled(owner, "visits", false);
    expect(await metrics.find("org", "visits", 1)).toBeNull();
    const request = {
      version: 1,
      expected_version: 2,
      effective_at: "2026-09-20 10:00:00",
      idempotency_key: "rollback-metric",
    };
    const rolled = await service.rollback(owner, "visits", request);
    expect(rolled.version).toBe(3);
    expect((await service.rollback(owner, "visits", request)).version).toBe(3);
    expect((await metrics.find("org", "visits"))?.version).toBe(3);
    expect((await metrics.find("org", "visits", 1))?.name).toBe(definition.name);
  });
  it("固定时间依据和重复版本在正式发布事务拒绝，失败不留下知识版本", async () => {
    const initial = { ...definition, metric_id: "immutable" };
    await publishMetric(initial);
    for (const metric of [
      { ...initial, name: "重复版本" },
      {
        ...initial,
        version: 2,
        date_basis: { field: "v.registered_on", data_type: "date" as const },
      },
    ]) {
      await expect(publishMetric(metric)).rejects.toBeInstanceOf(ApplicationError);
      expect(await repository.listVersions("org", "immutable")).toHaveLength(1);
    }
    expect((await metrics.find("org", "immutable"))?.date_basis).toEqual(initial.date_basis);
  });
  it("权限变化拒绝规则正文，私有来源不会通过支持接口向其他账号泄露", async () => {
    const candidate = await submitRule("来源相关规则", {
      analysis_run_id: "private",
      evidence_ids: ["private-evidence"],
    });
    await expect(
      service.getCandidate({ ...author, userId: "revoked" }, candidate.candidate_id),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.support(owner, candidate.candidate_id, {})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      service.assignOwner(manager, candidate.candidate_id, "owner", 1),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const result = await service.listSources(administrator, candidate.candidate_id);
    expect(result).toEqual([]);
    expect(await service.listCandidates(administrator, true)).not.toContainEqual(candidate);
  });

  it("管理读取跨服务重建保留未来与停用状态，负责人选项严格按组织和有效账号", async () => {
    const candidate = await submitRule("管理页未来版本");
    await approve(candidate);
    const record = await service.publish(owner, candidate.candidate_id, {
      expected_version: 1,
      effective_at: "2027-01-01 00:00:00",
    });
    expect(await service.getManagement(manager, record.knowledge_id)).toMatchObject({
      enabled: true,
      latest: { version: 1 },
      current: null,
    });
    await service.setEnabled(owner, record.knowledge_id, false);
    const reloaded = new SqlKnowledgeRepository(database);
    expect(
      await reloaded.listManagement("org", "2026-09-20 10:00:00", "owner", record.knowledge_id),
    ).toMatchObject([{ enabled: false, latest: { version: 1 }, current: null }]);
    expect(await reloaded.listManagement("other", "2026-09-20 10:00:00")).toEqual([]);
    expect(
      await reloaded.listManagement("org", "2026-09-20 10:00:00", "author", record.knowledge_id),
    ).toEqual([]);
    const owners = await service.ownerOptions(manager, { keyword: "负责人", limit: 10 });
    expect(owners).toEqual([{ user_id: "owner", username: "owner", display_name: "负责人" }]);
    expect(
      (await service.ownerOptions(manager, {})).some((item) => item.user_id === "disabled"),
    ).toBe(false);
    expect(await service.ownerOptions(manager, { keyword: "%_[]'", limit: 10 })).toEqual([]);
  });
});
