import { createHash, randomUUID } from "node:crypto";
import {
  reportRevisionInputSchema,
  reportRevisionBindingSchema,
  stableStringify,
  reportNarrativeSchema,
  type RunLease,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { runTime } from "../analysis-runs/run-time";
import { modelQueryResult } from "../runtime/model-query-result";
import { stageReportDefinitionSchema } from "./report-revision-records";
import type { ReportRevisionDependencies, ReportEditContext } from "./report-revision-types";

/** 对话只暂存结构化修改，运行成功后才提交报表版本。 */
class ReportRevisionService {
  constructor(private readonly dependencies: ReportRevisionDependencies) {}

  /** 工具门禁只读取固定目标，分析说明运行的取数范围限制为该次执行。 */
  async target(context: AuthContext, runId: string) {
    return this.dependencies.repository.get(context, runId);
  }

  /** 只读恢复入口：仓储限定组织和账号，定义服务重新核对当前权限。 */
  async binding(context: AuthContext, reportId: string, runId: string) {
    const target = await this.dependencies.repository.get(context, runId);
    if (
      !target ||
      target.mode !== "revision" ||
      target.report_id !== reportId ||
      target.expected_version < 1
    )
      throw new ApplicationError("NOT_FOUND", "报表修改任务不存在");
    const version = await this.dependencies.definitions.get(
      context,
      reportId,
      target.expected_version,
    );
    if (version.user_id !== context.userId || version.organization_id !== context.organizationId)
      throw new ApplicationError("UNAUTHORIZED", "仅作者可以恢复报表修改");
    return reportRevisionBindingSchema.parse({
      report_id: reportId,
      analysis_run_id: runId,
      expected_version: target.expected_version,
    });
  }

  async revise(context: AuthContext, reportId: string, input: unknown) {
    const request = reportRevisionInputSchema.parse(input);
    const version = await this.dependencies.definitions.get(
      context,
      reportId,
      request.expected_version,
    );
    if (version.user_id !== context.userId)
      throw new ApplicationError("UNAUTHORIZED", "仅作者可以修改报表定义");
    if (version.version !== request.expected_version)
      throw new ApplicationError("CONFLICT", "报表已更新");
    return this.create(
      context,
      {
        mode: "revision",
        report_id: reportId,
        expected_version: version.version,
        definition: version.definition,
      },
      request,
    );
  }

  async narrate(context: AuthContext, executionId: string, input: unknown) {
    const execution = await this.dependencies.executions.get(context, executionId);
    if (execution.status !== "completed")
      throw new ApplicationError("CONFLICT", "分析说明需要完成的执行结果");
    const request = reportRevisionInputSchema.parse({
      ...(input as object),
      expected_version: execution.definition_version,
    });
    return this.create(
      context,
      {
        mode: "narrative",
        report_id: execution.report_id,
        expected_version: execution.definition_version,
        execution_id: executionId,
      },
      request,
    );
  }

  private async create(
    context: AuthContext,
    target: ReportEditContext,
    request: ReturnType<typeof reportRevisionInputSchema.parse>,
  ) {
    if (!this.dependencies.selectAgent)
      throw new ApplicationError("UNSUPPORTED_QUERY", "当前未启用对话分析");
    const agent = await this.dependencies.selectAgent(context, request.agent_id);
    const hash = createHash("sha256").update(stableStringify({ target, request })).digest("hex");
    const result = await this.dependencies.repository.create(
      context,
      target,
      request.prompt,
      request.idempotency_key,
      hash,
      agent,
    );
    this.dependencies.wake?.();
    return result;
  }

  /** 模型上下文中的定义与结果均由当前权限读取，不能依靠模型传入目标。 */
  async read(context: AuthContext, runId: string, reportId?: string) {
    const target = await this.dependencies.repository.get(context, runId);
    if (target?.mode === "narrative") {
      const execution = await this.dependencies.executions.get(context, target.execution_id);
      return {
        target,
        results: execution.results.map((result) => ({
          query_id: result.query_id,
          evidence_id: result.evidence.evidence_id,
          result: modelQueryResult(result.evidence.result),
        })),
      };
    }
    if (target) {
      if (reportId && reportId !== target.report_id)
        throw new ApplicationError("INVALID_INPUT", "报表标识与当前编辑目标不同");
      if (target.expected_version > 0)
        await this.dependencies.definitions.get(context, target.report_id, target.expected_version);
      return target;
    }
    return reportId ? this.dependencies.definitions.get(context, reportId) : null;
  }

  async stage(context: AuthContext, runId: string, lease: RunLease, input: unknown) {
    const request = stageReportDefinitionSchema.parse(input);
    return this.dependencies.runs.withLease(context, runId, lease, async (executor) => {
      let target = await this.dependencies.repository.get(context, runId, executor);
      if (target?.mode === "narrative")
        throw new ApplicationError("INVALID_INPUT", "分析说明运行不能修改定义");
      if (!target) {
        if (request.report_id || request.expected_version)
          throw new ApplicationError("INVALID_INPUT", "修改已有报表需从该报表发起对话修改");
        target = { mode: "revision", report_id: randomUUID(), expected_version: 0 };
        await this.dependencies.repository.initialize(context, runId, target, executor);
      }
      if (
        (request.report_id && request.report_id !== target.report_id) ||
        (request.expected_version && request.expected_version !== target.expected_version)
      )
        throw new ApplicationError("INVALID_INPUT", "提交与绑定的报表及基准版本不同");
      if (target.expected_version > 0) {
        const current = await this.dependencies.definitions.get(
          context,
          target.report_id,
          undefined,
          executor,
        );
        if (current.user_id !== context.userId || current.version !== target.expected_version)
          throw new ApplicationError("CONFLICT", "报表已更新或不可编辑");
      }
      await this.dependencies.validate(context, request.definition, executor);
      await this.dependencies.repository.stage(context, runId, request.definition, executor);
      return {
        report_id: target.report_id,
        expected_version: target.expected_version,
        status: "staged" as const,
      };
    });
  }

  async complete(
    context: AuthContext,
    runId: string,
    executor: MetadataQueryExecutor,
    content: string,
  ): Promise<void> {
    const target = await this.dependencies.repository.get(context, runId, executor);
    if (!target) return;
    if (target.mode === "narrative") {
      const execution = await this.dependencies.executions.get(
        context,
        target.execution_id,
        executor,
      );
      if (execution.status !== "completed")
        throw new ApplicationError("CONFLICT", "分析来源未完成");
      await this.dependencies.repository.saveNarrative(
        context,
        reportNarrativeSchema.parse({
          execution_id: target.execution_id,
          analysis_run_id: runId,
          content,
          query_ids: execution.results.map((result) => result.query_id),
          created_at: runTime(),
        }),
        executor,
      );
      return;
    }
    const definition = await this.dependencies.repository.staged(context, runId, executor);
    if (!definition) throw new ApplicationError("CONFLICT", "对话未提交报表定义修改");
    const current =
      target.expected_version > 0
        ? await this.dependencies.definitions.get(context, target.report_id, undefined, executor)
        : null;
    await this.dependencies.definitions.save(
      context,
      { definition, shared_with: current?.shared_with ?? [] },
      target.report_id,
      target.expected_version,
      executor,
    );
  }

  async narratives(context: AuthContext, executionId: string) {
    await this.dependencies.executions.get(context, executionId);
    return this.dependencies.repository.narratives(context, executionId);
  }
}
export { ReportRevisionService };
