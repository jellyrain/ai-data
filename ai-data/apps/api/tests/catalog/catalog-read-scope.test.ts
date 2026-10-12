import { describe, expect, it, vi } from "vitest";
import { queryDslSchema, reportDefinitionSchema, metricDefinitionSchema } from "@ai-data/contracts";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { withCatalogReadScope } from "../../src/catalog/catalog-read-scope";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { ReportQueryService } from "../../src/reports/report-query-service";
import { MetricService } from "../../src/metrics/metric-service";
import { AnalysisRunService } from "../../src/analysis-runs/analysis-run-service";
import { ConversationService } from "../../src/conversations/conversation-service";
import { context, createApiDependencies } from "../support/api-fixtures";
import type { JwtService } from "../../src/auth/jwt-service";
import type { QueryEvidence } from "@ai-data/contracts";
import type { AuthContext } from "../../src/auth/auth-types";
import { AnalysisExecutor } from "../../src/runtime/analysis-executor";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { createMemoryServices } from "../../src/memory/create-memory-services";
import { memoryTaskConfigSchema } from "../../src/config/memory-task-config";
import type { HarnessRequest } from "../../src/harness/harness-types";
import type { AnalysisRunState } from "@ai-data/contracts";
import type { RunChange } from "../../src/analysis-runs/analysis-run-types";

/** 目录与权限走正式实现，外部仓储及签名使用可计数替身。 */
function setup() {
  const raw = vi.fn(async () => [
    {
      source_id: "clinical",
      object_id: "visit",
      name: "就诊",
      kind: "table" as const,
      columns: [
        { name: "id", data_type: "integer" as const, nullable: false },
        { name: "department", data_type: "string" as const, nullable: false },
        { name: "visited_on", data_type: "date" as const, nullable: false },
      ],
      query_parameters: [],
    },
  ]);
  const permissions = createApiDependencies().catalog.permissions;
  const catalog = new BusinessCatalogService(
    { listRawCatalog: raw },
    {
      find: async () => null,
      listBySourceId: async () => [],
      save: async () => {},
    },
    permissions,
  );
  const authorization = new QueryAuthorizationService(catalog, {
    signInternalQueryToken: async () => "token",
    signQueryRequest: () => "signature",
  } as unknown as JwtService);
  const query = queryDslSchema.parse({
    type: "relational_query",
    source_id: "clinical",
    from: { object_id: "visit", alias: "v" },
    select: [{ field: "v.id" }, { field: "v.department" }],
  });
  return { raw, catalog, authorization, query };
}

describe("目录按业务读取批次复用", () => {
  it("单次查询授权只发现一次目录，下一次授权重新读取并拒绝已删除对象", async () => {
    const h = setup();
    await h.authorization.authorize(h.query, context);
    expect(h.raw).toHaveBeenCalledTimes(1);
    h.raw.mockResolvedValue([]);
    await expect(h.authorization.authorize(h.query, context)).rejects.toMatchObject({
      code: "UNAUTHORIZED_OBJECT",
    });
    expect(h.raw).toHaveBeenCalledTimes(2);
  });
  it("嵌套的只读服务沿用外层批次，独立并发请求分别读取", async () => {
    const h = setup();
    const read = () =>
      withCatalogReadScope(async () => {
        await h.catalog.listAuthorized(context, "clinical");
        await withCatalogReadScope(() => h.catalog.listAuthorized(context, "clinical"));
      });
    await Promise.all([read(), read()]);
    expect(h.raw).toHaveBeenCalledTimes(2);
  });
  it("报表多个查询与输出字段共用一次目录，输出定义保持一致", async () => {
    const h = setup();
    const service = new ReportQueryService({
      catalog: h.catalog,
      authorization: h.authorization,
      metrics: { get: vi.fn() },
    });
    const definition = reportDefinitionSchema.parse({
      title: "明细",
      queries: ["q1", "q2"].map((query_id) => ({ query_id, query: h.query, bindings: [] })),
      presentation: [
        {
          section_id: "s",
          title: "明细",
          blocks: [
            {
              block_id: "b",
              type: "table",
              title: "明细",
              query_ids: ["q1"],
              columns: ["id", "department"],
            },
          ],
        },
      ],
    });
    const result = await service.build(context, definition, {});
    expect(result.queries).toHaveLength(2);
    expect(h.raw).toHaveBeenCalledTimes(1);
  });
  it("多个指标的适用范围及逐维度校验共用本次列表目录", async () => {
    const h = setup();
    const metric = metricDefinitionSchema.parse({
      metric_id: "visits",
      version: 1,
      name: "就诊人次",
      description: "就诊去重",
      aliases: [],
      grain: "就诊",
      deduplication_keys: ["v.id"],
      date_basis: { field: "v.visited_on", data_type: "date" },
      dimensions: ["v.department"],
      total_rule: "recalculate",
      value: { type: "column", column: "value" },
      query: {
        ...h.query,
        select: [{ field: "v.id", aggregation: "count_distinct", as: "value" }],
      },
    });
    const service = new MetricService(
      {
        find: async () => metric,
        list: async () => [metric, metric],
        findPublicationScope: async () => ({ source_id: "clinical" }),
      } as unknown as ConstructorParameters<typeof MetricService>[0],
      h.authorization,
      {} as AnalysisRunService,
      {
        authorizeScope: async () => {
          await h.catalog.listAuthorized(context, "clinical");
        },
      },
    );
    expect(await service.list(context)).toHaveLength(2);
    expect(h.raw).toHaveBeenCalledTimes(1);
  });
  it("恢复多轮会话及每轮多份证据只读一次目录，下一批事件重新复核", async () => {
    const h = setup();
    const authorized = await h.authorization.authorize(h.query, context, "run");
    const evidence = Array.from({ length: 12 }, (_, i) => ({
      evidence_id: String(i),
      organization_id: context.organizationId,
      analysis_run_id: "run",
      requested_query: h.query,
      authorized_query: authorized.request.query,
      output_masks: authorized.request.access.output_masks,
    })) as QueryEvidence[];
    h.raw.mockClear();
    const runs = new AnalysisRunService({
      refreshContext: async (value: AuthContext) => value,
      authorization: h.authorization,
      repository: {
        get: async () => ({ status: "completed" }),
        listEvidence: async () => evidence,
        listEvents: async () => [],
      },
    } as unknown as ConstructorParameters<typeof AnalysisRunService>[0]);
    const conversations = new ConversationService(
      {
        findConversation: async () => ({ id: "c" }),
        listMessages: async () => [{ analysisRunId: "a" }, { analysisRunId: "b" }],
      } as unknown as ConstructorParameters<typeof ConversationService>[0],
      {
        authorizeRun: (identity, id) => runs.get(identity, id),
      },
    );
    expect(await conversations.get(context, "c")).not.toBeNull();
    expect(h.raw).toHaveBeenCalledTimes(1);
    await withCatalogReadScope(async () => {
      await runs.get(context, "run");
      h.raw.mockResolvedValue([]);
      await expect(runs.readEventBatch(context, "run", 0)).rejects.toMatchObject({
        code: "UNAUTHORIZED_OBJECT",
      });
    });
    expect(h.raw).toHaveBeenCalledTimes(3);
  });

  it("SQL 执行期间撤销对象，交付前开启新批次并拒绝保存证据", async () => {
    const h = setup();
    const lease = { owner: "worker", epoch: 1, expires_at: "2026-10-10 18:00:00" };
    const state = {
      status: "running",
      lease_epoch: 1,
      lease,
      evidence_ids: [],
    } as unknown as AnalysisRunState;
    const changes: RunChange[] = [];
    const runs = new AnalysisRunService({
      now: () => Date.parse("2026-10-10T08:00:00Z"),
      refreshContext: async () => context,
      authorization: h.authorization,
      repository: {
        get: async () => state,
        listEvidence: async () => [],
        change: async (
          _context: AuthContext,
          _id: string,
          apply: (state: AnalysisRunState) => RunChange,
        ) => {
          changes.push(apply(state));
          return state;
        },
      },
      client: {
        execute: async () => {
          h.raw.mockResolvedValue([]);
          return {
            columns: [
              { name: "id", data_type: "integer" },
              { name: "department", data_type: "string" },
            ],
            rows: [{ id: 1, department: "门诊" }],
            row_count: 1,
            truncated: false,
          };
        },
      },
    } as unknown as ConstructorParameters<typeof AnalysisRunService>[0]);
    await expect(
      withCatalogReadScope(() => runs.query(context, "run", lease, "q", h.query)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_OBJECT" });
    expect(h.raw).toHaveBeenCalledTimes(2);
    expect(changes.flatMap((change) => change.evidence ?? [])).toEqual([]);
  });

  it("恢复准备和每次文字交付分别复用，第二批撤权后停止输出", async () => {
    const h = setup();
    const read = async () => {
      await h.authorization.preview(h.query, context);
    };
    const fail = vi.fn();
    const recordMessage = vi.fn(read);
    const complete = vi.fn(read);
    const executor = new AnalysisExecutor({
      refreshContext: async () => context,
      runs: {
        claim: async () => ({ owner: "w", epoch: 1, expires_at: "2026-10-10 18:00:00" }),
        attachController: () => () => {},
        get: read,
        evidence: async () => {
          await read();
          return [];
        },
        recordMessage,
        recordMemoryContext: async () => {},
        complete,
        fail,
        interrupt: async () => {},
      },
      repository: {
        loadInput: async () => ({
          conversation_id: "c",
          context_hash: "hash",
          messages: [],
          run_ids: ["a", "b", "run"],
        }),
        loadContextHash: async () => "hash",
      },
      loadMemory: async () => {
        await read();
        return {};
      },
      loadMemoryFingerprint: async () => {
        await read();
        return [];
      },
      loadReportContext: read,
      tools: { definitions: () => [] },
      harness: {
        run: async (request: HarnessRequest) => {
          expect(h.raw).toHaveBeenCalledTimes(1);
          await request.onMessage!({ itemId: "m", status: "delta", content: "结果" });
          expect(h.raw).toHaveBeenCalledTimes(2);
          h.raw.mockResolvedValue([]);
          await request.onMessage!({ itemId: "m", status: "delta", content: "追加" });
          return { status: "completed", content: "结果" };
        },
      },
    } as unknown as ConstructorParameters<typeof AnalysisExecutor>[0]);
    await executor.execute(context, "run");
    expect(h.raw).toHaveBeenCalledTimes(3);
    expect(recordMessage).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      context,
      "run",
      expect.anything(),
      expect.objectContaining({ code: "UNAUTHORIZED_OBJECT" }),
    );
  });

  it("数据集说明连同适用知识共用目录，下一次工具重新读取", async () => {
    const h = setup();
    const tools = new AnalysisTools({
      catalog: h.catalog,
      refreshContext: async () => context,
      runs: { assertCurrent: async () => {}, recordTool: async () => {} },
      memory: {
        businessRules: async () => {
          await h.catalog.listAuthorized(context, "clinical");
          return [];
        },
      },
    } as unknown as ConstructorParameters<typeof AnalysisTools>[0]);
    const lease = { owner: "w", epoch: 1, expires_at: "2026-10-10 18:00:00" };
    const invoke = () =>
      tools.execute(
        context,
        "run",
        lease,
        "describe_dataset",
        { source_id: "clinical", object_id: "visit" },
        "call",
      );
    expect(await invoke()).toMatchObject({
      success: true,
      output: { dataset: { object_id: "visit" } },
    });
    expect(h.raw).toHaveBeenCalledTimes(1);
    h.raw.mockResolvedValue([]);
    expect(await invoke()).toMatchObject({ success: false, output: { code: "NOT_FOUND" } });
    expect(h.raw).toHaveBeenCalledTimes(2);
  });

  it("记忆装配复用主目录服务，同一事务复用实例且不同事务隔离", async () => {
    const h = setup();
    const execute = async () => ({ rows: [], rowsAffected: [] });
    const database = { execute };
    const memory = createMemoryServices({
      database,
      catalog: h.catalog,
      queryAuthorization: h.authorization,
      config: { memory_tasks: memoryTaskConfigSchema.parse({ enabled: false }) },
    } as unknown as Parameters<typeof createMemoryServices>[0]);
    const first = { execute },
      second = { execute };
    expect(memory.catalogForExecutor(database)).toBe(h.catalog);
    expect(memory.catalogForExecutor(first)).toBe(memory.catalogForExecutor(first));
    expect(memory.catalogForExecutor(first)).not.toBe(memory.catalogForExecutor(second));
    await withCatalogReadScope(async () => {
      await h.authorization.preview(h.query, context);
      await memory.access.scope(context, { source_id: "clinical", object_id: "visit" });
    });
    expect(h.raw).toHaveBeenCalledTimes(1);
  });
});
