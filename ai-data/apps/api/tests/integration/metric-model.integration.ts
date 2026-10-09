import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { metricDefinitionSchema, metricExecutionInputSchema } from "@ai-data/contracts";
import { AnalysisTools } from "../../src/runtime/analysis-tools";
import { buildMetricQueries } from "../../src/metrics/metric-service";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import { ApplicationError } from "../../src/errors/application-error";
import { context, createApiDependencies } from "../support/api-fixtures";
import { readConfiguredDialogueRuntime } from "./dialogue-model-fixture";

// 显式启用时验证真实模型对生产工具说明的理解；查询结果使用样本，SQL 链路由隔离业务集成另行验证。
it.runIf(process.env.LOCAL_MODEL_ACCEPTANCE === "1")(
  "本地模型按指标详情一次生成正确的 datetime 查询参数",
  async () => {
    const { provider, agent } = await readConfiguredDialogueRuntime();
    const metric = metricDefinitionSchema.parse({
      metric_id: "fixture-visits",
      version: 1,
      name: "门诊就诊人次",
      description: "按就诊时间统计完成的门诊记录",
      aliases: ["门诊人次"],
      grain: "就诊记录",
      deduplication_keys: ["v.id"],
      date_basis: { field: "v.visited_at", data_type: "datetime" },
      dimensions: ["v.department"],
      total_rule: "recalculate",
      value: { type: "column", column: "visits" },
      query: {
        type: "relational_query",
        source_id: "fixture-clinical",
        from: { object_id: "visits", alias: "v" },
        select: [{ field: "v.id", aggregation: "count_distinct", as: "visits" }],
      },
    });
    const api = createApiDependencies();
    const metrics = {
      list: async () => [metric],
      get: async () => metric,
      query: async (_context: unknown, metricId: string, input: unknown) => {
        expect(metricId).toBe(metric.metric_id);
        const request = metricExecutionInputSchema.parse(input);
        buildMetricQueries(metric, request);
        return {
          metric_id: metric.metric_id,
          version: 1,
          grouped: {
            columns: [
              { name: "dimension_0", data_type: "string" },
              { name: "visits", data_type: "integer" },
            ],
            rows: [
              { dimension_0: "A科", visits: 8 },
              { dimension_0: "B科", visits: 5 },
            ],
            row_count: 2,
            truncated: false,
          },
          values: [8, 5],
          total: 13,
          evidence_ids: ["fixture-groups", "fixture-total"],
        };
      },
    };
    const tools = new AnalysisTools({
      metrics,
      runs: { assertCurrent: vi.fn(async () => {}), recordTool: vi.fn(async () => {}) },
      catalog: api.catalog.service,
      reports: api.analysis.reports,
      refreshContext: api.auth.refreshContext,
      listSourceIds: async () => ["fixture-clinical"],
      allowedNames: ["list_metrics", "describe_metric", "query_metric"],
    } as unknown as ConstructorParameters<typeof AnalysisTools>[0]);
    const root = resolve("secrets");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "metric-model-test-"));
    if (dirname(directory) !== root) throw new Error("模型测试目录超出项目范围");
    const harness = new CodexAnalysisHarness({
      stateDirectory: directory,
      provider,
      timeoutMs: 600000,
    });
    const attempts: { name: string; input: unknown; success: boolean; output: unknown }[] = [];
    const outputDirectory = fileURLToPath(
      new URL("../../../../../任务交接/query_metric参数提示验收/", import.meta.url),
    );
    try {
      const result = await harness.run({
        sessionKey: "metric-format-acceptance",
        signal: new AbortController().signal,
        onThreadStarted: async () => {},
        instructions: agent.instructions,
        input: "查询 2026 年 8 月各科室门诊就诊人次，列出科室明细及总计。",
        tools: tools.definitions(),
        executeTool: async (name, input, callId) => {
          if (attempts.length >= 12)
            throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "验收工具调用次数已达上限");
          const result = await tools.execute(
            context,
            "fixture-run",
            { owner: "test", epoch: 1, expires_at: "2026-10-08 23:59:59" },
            name,
            input,
            callId,
          );
          attempts.push({ name, input, success: result.success, output: result.output });
          return result;
        },
      });
      expect(result.status, JSON.stringify(attempts)).toBe("completed");
      expect(attempts.some((item) => item.name === "describe_metric" && item.success)).toBe(true);
      const queries = attempts.filter((item) => item.name === "query_metric");
      expect(queries, JSON.stringify(attempts)).toHaveLength(1);
      expect(queries[0]).toMatchObject({
        success: true,
        input: {
          start: "2026-08-01 00:00:00",
          end: "2026-08-31 23:59:59",
          dimensions: ["v.department"],
        },
      });
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        join(outputDirectory, "真实模型验收.json"),
        JSON.stringify({ model: provider.model, status: result.status, attempts }, null, 2),
      );
    } finally {
      await harness.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  650000,
);
