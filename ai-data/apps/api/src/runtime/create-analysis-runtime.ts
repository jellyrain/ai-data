import { resolve } from "node:path";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { ApiConfig } from "../config/api-config";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { BusinessCatalogService } from "../catalog/business-catalog-service";
import type { MetricService } from "../metrics/metric-service";
import type { ReportService } from "../reports/report-service";
import { CodexAnalysisHarness } from "../harness/codex-analysis-harness";
import { SkillResources } from "../skills/skill-resources";
import { AnalysisTools } from "./analysis-tools";
import { AnalysisExecutor } from "./analysis-executor";
import { PollingAnalysisDispatcher } from "./analysis-dispatcher";
import { SqlRuntimeRepository } from "./sql-runtime-repository";
import type { AgentRuntime } from "./agent-runtime";
import type { MemoryRuntime } from "../memory/memory-runtime";
import type { ReportRevisionService } from "../reports/report-revision-service";
import type { ReportExecutionService } from "../reports/report-execution-service";

/** 启动服务级调度与官方进程，每次运行按会话绑定装配数据库模型及 Agent 预算。 */
function createAnalysisRuntime(dependencies: {
  config: NonNullable<ApiConfig["analysis_runtime"]>;
  database: MetadataTransactionalExecutor;
  runs: AnalysisRunService;
  catalog: BusinessCatalogService;
  metrics: MetricService;
  reports: ReportService;
  refreshContext: (context: AuthContext) => Promise<AuthContext>;
  startupDirectory: string;
  skillsDirectory: string;
  onError: (error: unknown) => void;
  listSourceIds: () => Promise<string[]>;
  agents: Pick<AgentRuntime, "resolveRun">;
  memory?: MemoryRuntime;
  reportEditing?: ReportRevisionService;
  reportExecutions?: ReportExecutionService;
}) {
  const { config } = dependencies;
  const skills = new SkillResources(dependencies.skillsDirectory, []);
  const harness = new CodexAnalysisHarness({
    stateDirectory: resolve(dependencies.startupDirectory, config.state_directory),
  });
  const repository = new SqlRuntimeRepository(dependencies.database);
  const tools = new AnalysisTools({ ...dependencies, skills });
  const executor = new AnalysisExecutor({
    ...dependencies,
    repository,
    ...(dependencies.reportEditing
      ? {
          loadReportContext: (context: AuthContext, runId: string) =>
            dependencies.reportEditing!.read(context, runId),
        }
      : {}),
    ...(dependencies.memory
      ? {
          loadMemory: (context: AuthContext) => dependencies.memory!.snapshot(context),
          loadMemoryFingerprint: (context: AuthContext) =>
            dependencies.memory!.fingerprint(context),
        }
      : {}),
    tools,
    harness,
    instructions: "",
    resolveConfiguration: async (context: AuthContext, runId: string) => {
      const selected = await dependencies.agents.resolveRun(context, runId);
      return {
        ...selected,
        instructions: selected.agent.instructions,
        tools: new AnalysisTools({
          ...dependencies,
          skills: selected.configuration.skills,
          allowedNames: selected.agent.tool_names,
        }),
        maxToolCalls: selected.agent.limits.max_tool_calls,
        maxContextBytes: selected.agent.limits.max_context_bytes,
      };
    },
  });
  const dispatcher = new PollingAnalysisDispatcher({
    repository,
    executor,
    refreshContext: dependencies.refreshContext,
    concurrency: config.concurrency,
    pollMs: config.poll_ms,
    onError: dependencies.onError,
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      try {
        await dispatcher.close();
      } finally {
        await harness.close();
      }
    })();
    return closing;
  };
  const start = async () => {
    try {
      await harness.start();
      dispatcher.start();
    } catch (error) {
      await close();
      throw error;
    }
  };
  return { dispatcher, repository, start, close };
}
export { createAnalysisRuntime };
