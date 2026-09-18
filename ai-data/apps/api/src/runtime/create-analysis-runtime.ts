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

/** 选择部署配置中的模型提供方，业务服务与模型传输分别装配。 */
function createAnalysisRuntime(dependencies: {
  config: NonNullable<ApiConfig["analysis_runtime"]>;
  database: MetadataTransactionalExecutor;
  runs: AnalysisRunService;
  catalog: BusinessCatalogService;
  metrics: MetricService;
  reports: ReportService;
  refreshContext: (context: AuthContext) => Promise<AuthContext>;
  instructions: string;
  startupDirectory: string;
  skillsDirectory: string;
  onError: (error: unknown) => void;
  listSourceIds: () => Promise<string[]>;
}) {
  const { config } = dependencies;
  const selected = config.providers.find((provider) => provider.id === config.active_provider)!;
  const skills = new SkillResources(dependencies.skillsDirectory);
  const harness = new CodexAnalysisHarness({
    provider: {
      id: selected.id,
      baseUrl: selected.base_url,
      model: selected.model,
      apiKey: selected.api_key,
      headers: selected.headers,
    },
    timeoutMs: config.timeout_ms,
    stateDirectory: resolve(dependencies.startupDirectory, config.state_directory),
    skills,
    contextWindow: config.context_window,
  });
  const repository = new SqlRuntimeRepository(dependencies.database);
  const tools = new AnalysisTools({ ...dependencies, skills });
  const executor = new AnalysisExecutor({
    ...dependencies,
    repository,
    tools,
    harness,
    runtimeKey: JSON.stringify({
      provider: { id: selected.id, model: selected.model, baseUrl: selected.base_url },
      skills: skills.fingerprint,
    }),
    maxToolCalls: config.max_tool_calls,
    maxContextBytes: config.max_context_bytes,
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
