import { createHash, randomUUID } from "node:crypto";
import dayjs from "dayjs";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import {
  reportExecutionInputSchema,
  reportExecutionSchema,
  reportExecutionExportContentSchema,
  savedReportSchema,
  stableStringify,
  type ReportExecution,
  type RunLease,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { runTime, runTimeMilliseconds } from "../analysis-runs/run-time";
import { assertAnalysisResultBudget } from "../analysis-runs/analysis-query";
import type { ReportExecutionDependencies } from "./report-execution-types";

/** 所有入口使用同一执行状态机；执行结果在全部查询通过后一次提交。 */
class ReportExecutionService {
  private readonly now: () => number;
  constructor(private readonly dependencies: ReportExecutionDependencies) {
    this.now = dependencies.now ?? (() => dayjs().valueOf());
  }

  async execute(context: AuthContext, reportId: string, input: unknown): Promise<ReportExecution> {
    const request = reportExecutionInputSchema.parse(input);
    context = await this.dependencies.refreshContext(context);
    const hash = createHash("sha256").update(stableStringify(request)).digest("hex");
    const previous = await this.dependencies.repository.findOperation(
      context,
      reportId,
      request.idempotency_key,
    );
    if (previous) {
      if (previous.requestHash !== hash)
        throw new ApplicationError("CONFLICT", "执行操作键已用于其他版本或参数");
      return this.get(context, previous.record.execution_id);
    }
    const definition = await this.dependencies.definitions.get(
      context,
      reportId,
      request.definition_version,
    );
    const built = await this.dependencies.builder.build(
      context,
      definition.definition,
      request.parameters,
    );
    const timeout = this.dependencies.timeoutMilliseconds ?? 120000;
    const deadline = runTime(dayjs(this.now()).add(timeout, "millisecond"));
    const start = await this.dependencies.repository.start(
      context,
      reportId,
      hash,
      request.idempotency_key,
      definition,
      built.parameters,
      deadline,
    );
    if (!start.isNew) return this.get(context, start.record.execution_id);
    const record = start.record;
    let lease: RunLease | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let interrupted = false;
    let renewing = false;
    try {
      lease = await this.dependencies.runs.claim(context, record.analysis_run_id, randomUUID());
      record.lease_epoch = lease.epoch;
      const activeLease = lease;
      const work = async () => {
        const results: ReportExecution["results"] = [];
        let rows = 0,
          bytes = 0;
        for (const item of built.queries) {
          this.assertDeadline(record, interrupted);
          const evidence = await this.dependencies.runs.query(
            context,
            record.analysis_run_id,
            activeLease,
            "report-" +
              createHash("sha256").update(`${record.execution_id}:${item.query_id}`).digest("hex"),
            item.query,
            item.metric,
            { managed: true },
          );
          this.assertDeadline(record, interrupted);
          assertAnalysisResultBudget(evidence.result);
          rows += evidence.result.row_count;
          bytes += Buffer.byteLength(JSON.stringify(evidence.result), "utf8");
          if (rows > 5000 || bytes > 2 * 1024 * 1024)
            throw new ApplicationError(
              "QUERY_LIMIT_EXCEEDED",
              "报表合计结果超出五千行或 2 MiB 容量",
            );
          results.push({ query_id: item.query_id, evidence });
        }
        context = await this.dependencies.refreshContext(context);
        const current = await this.dependencies.definitions.get(context, reportId);
        for (const result of results)
          await this.dependencies.authorizeEvidence(context, result.evidence);
        const sources = results.map((result) => result.evidence);
        const sections = record.definition.presentation
          .map((section) => ({
            ...section,
            blocks: section.blocks
              .filter(
                (block) =>
                  block.type !== "text" || block.source_execution_id === record.execution_id,
              )
              .map((block) => ({
                block_id: block.block_id,
                type: block.type,
                title: block.title,
                evidence_ids: block.query_ids.map(
                  (id) => results.find((result) => result.query_id === id)!.evidence.evidence_id,
                ),
                ...(block.chart ? { chart: block.chart } : {}),
                ...(block.columns ? { columns: block.columns } : {}),
                ...(block.content ? { content: block.content } : {}),
              })),
          }))
          .filter((section) => section.blocks.length > 0);
        // 历史说明不复制为新结论；纯说明模板本轮仍交付全部结果表。
        if (!sections.length)
          sections.push({
            section_id: "results",
            title: record.definition.title,
            blocks: results.map((result) => ({
              block_id: result.query_id,
              type: "table",
              title: result.query_id,
              evidence_ids: [result.evidence.evidence_id],
            })),
          });
        const snapshot = savedReportSchema.parse({
          report_id: record.report_id,
          version: record.definition_version,
          definition_version: record.definition_version,
          execution_id: record.execution_id,
          analysis_run_id: record.analysis_run_id,
          organization_id: record.organization_id,
          user_id: record.user_id,
          created_at: runTime(this.now()),
          title: record.definition.title,
          shared_with: current.shared_with,
          sections,
          sources,
        });
        let completed = reportExecutionSchema.parse({
          ...record,
          status: "completed",
          completed_at: runTime(this.now()),
          results,
          snapshot,
        });
        this.assertDeadline(record, interrupted);
        await this.dependencies.runs.complete(
          context,
          record.analysis_run_id,
          activeLease,
          "报表执行完成",
          async (executor) => {
            this.assertDeadline(record, interrupted);
            completed = await this.dependencies.repository.finish(context, completed, executor);
            this.assertDeadline(record, interrupted);
          },
        );
        return completed;
      };
      heartbeat = setInterval(() => {
        if (renewing || interrupted) return;
        renewing = true;
        void this.dependencies.runs
          .renew(context, record.analysis_run_id, activeLease)
          .catch(() => {
            interrupted = true;
            void this.dependencies.runs.interrupt(record.analysis_run_id);
          })
          .finally(() => {
            renewing = false;
          });
      }, 5000);
      heartbeat.unref();
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            interrupted = true;
            reject(new ApplicationError("QUERY_TIMEOUT", "报表执行超过总时限"));
          }, timeout);
        }),
      ]);
    } catch (error) {
      interrupted = true;
      if (lease) await this.dependencies.runs.fail(context, record.analysis_run_id, lease, error);
      await this.dependencies.runs.interrupt(record.analysis_run_id);
      return this.dependencies.repository.finish(
        context,
        reportExecutionSchema.parse({
          ...record,
          status: "failed",
          completed_at: runTime(this.now()),
          results: [],
          error_code: error instanceof ApplicationError ? error.code : "INTERNAL_ERROR",
        }),
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  /** 结果读取同时复核最新报表 ACL 与完整证据权限，重复执行也走这一入口。 */
  async get(
    context: AuthContext,
    executionId: string,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportExecution> {
    // 事务调用方已经刷新身份，同一连接完成历史权限复核。
    if (!executor) context = await this.dependencies.refreshContext(context);
    let record = await this.dependencies.repository.find(context, executionId, executor);
    if (!record) throw new ApplicationError("NOT_FOUND", "报表执行不存在");
    await this.dependencies.definitions.get(context, record.report_id, undefined, executor);
    if (record.status === "running" && this.now() >= runTimeMilliseconds(record.deadline))
      record = await this.dependencies.repository.finish(
        context,
        reportExecutionSchema.parse({
          ...record,
          status: "failed",
          results: [],
          error_code: "QUERY_TIMEOUT",
          completed_at: runTime(this.now()),
        }),
        executor,
      );
    for (const result of record.results)
      await this.dependencies.authorizeEvidence(context, result.evidence, executor);
    return record;
  }

  async exportContent(context: AuthContext, executionId: string) {
    const execution = await this.get(context, executionId);
    if (execution.status !== "completed")
      throw new ApplicationError("CONFLICT", "报表执行尚未完成");
    return reportExecutionExportContentSchema.parse({
      kind: "report_execution",
      execution,
      narratives: (await this.dependencies.narratives?.(context, executionId)) ?? [],
    });
  }

  private assertDeadline(record: ReportExecution, interrupted: boolean): void {
    if (interrupted || this.now() >= runTimeMilliseconds(record.deadline))
      throw new ApplicationError("QUERY_TIMEOUT", "报表执行超过总时限");
  }
}
export { ReportExecutionService };
