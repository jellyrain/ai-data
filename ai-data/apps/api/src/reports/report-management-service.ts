import dayjs from "dayjs";
import {
  analysisArtifactSchema,
  conversationExportContentSchema,
  reportExportContentSchema,
  reportListInputSchema,
  reportListSchema,
  reportSharingInputSchema,
  reportSummarySchema,
  reportVersionListSchema,
  type AnalysisArtifact,
  type ConversationExportContent,
  type QueryEvidence,
  type ReportDefinitionVersion,
  type ReportExportContent,
  type ReportList,
  type ReportSummary,
  type ReportVersionList,
  type SavedReport,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { runTime } from "../analysis-runs/run-time";
import type { ReportManagementDependencies } from "./report-management-types";

/** 列表、历史与导出共用正式读取授权，任一来源不足时不交付整份内容。 */
class ReportManagementService {
  constructor(private readonly dependencies: ReportManagementDependencies) {}
  async list(context: AuthContext, input: unknown = {}): Promise<ReportList> {
    const request = reportListInputSchema.parse(input);
    const items: ReportSummary[] = [];
    let cursor = request.cursor;
    while (items.length <= request.limit) {
      const ids = await this.dependencies.repository.listReportIds(
        context.organizationId,
        cursor,
        100,
      );
      for (const id of ids) {
        cursor = id;
        try {
          const summary = await this.summary(context, id);
          if (summary) items.push(summary);
        } catch (error) {
          if (!this.hidden(error)) throw error;
        }
        if (items.length > request.limit) break;
      }
      if (ids.length < 100 || items.length > request.limit) break;
    }
    const page = items.slice(0, request.limit);
    return reportListSchema.parse({
      items: page,
      ...(items.length > request.limit ? { next_cursor: page.at(-1)!.report_id } : {}),
    });
  }
  async versions(context: AuthContext, id: string): Promise<ReportVersionList> {
    const definitions =
      (await this.optional(() => this.dependencies.definitions.versions(context, id))) ?? [];
    const snapshots = [];
    for (const version of await this.dependencies.repository.snapshotVersions(
      context.organizationId,
      id,
    ))
      snapshots.push(await this.dependencies.reports.get(context, id, version));
    if (!definitions.length && !snapshots.length)
      throw new ApplicationError("NOT_FOUND", "报表不存在");
    return reportVersionListSchema.parse({ definitions, snapshots });
  }
  async share(
    context: AuthContext,
    id: string,
    input: unknown,
  ): Promise<ReportDefinitionVersion | SavedReport> {
    const request = reportSharingInputSchema.parse(input);
    const definition = await this.optional(() => this.dependencies.definitions.get(context, id));
    return definition
      ? this.dependencies.definitions.share(context, id, request)
      : this.dependencies.reports.share(context, id, request.expected_version, request.shared_with);
  }
  async artifacts(context: AuthContext, runId: string): Promise<AnalysisArtifact[]> {
    await this.dependencies.source(context, runId, true);
    const artifacts = await this.dependencies.repository.artifacts(context.organizationId, runId);
    const result: AnalysisArtifact[] = [];
    for (const artifact of artifacts) {
      const report = await this.dependencies.reports.get(
        context,
        artifact.report.report_id,
        artifact.report.version,
      );
      if (report.analysis_run_id !== runId)
        throw new ApplicationError("INTERNAL_ERROR", "产物来源记录不一致");
      result.push(analysisArtifactSchema.parse({ ...artifact, report }));
    }
    return result;
  }
  async exportReport(
    context: AuthContext,
    id: string,
    version?: number,
  ): Promise<ReportExportContent> {
    const report = await this.dependencies.reports.get(context, id, version);
    return reportExportContentSchema.parse({
      kind: "report",
      report,
      tables: report.sources.map((evidence) => this.exportEvidence(evidence)),
    });
  }
  async exportConversation(context: AuthContext, id: string): Promise<ConversationExportContent> {
    const detail = await this.dependencies.conversations.get(context, id);
    if (!detail) throw new ApplicationError("NOT_FOUND", "会话不存在");
    const messages = detail.messages
      .filter((message) => ["user", "assistant"].includes(message.role))
      .sort((a, b) => a.sequence - b.sequence);
    const runIds = [
      ...new Set(
        messages.flatMap((message) => (message.analysisRunId ? [message.analysisRunId] : [])),
      ),
    ];
    const runs = [];
    const artifacts: AnalysisArtifact[] = [];
    const tables = new Map<string, QueryEvidence>();
    for (const runId of runIds) {
      const state = await this.dependencies.runs.get(context, runId);
      runs.push({ analysis_run_id: runId, status: state.status });
      if (state.status !== "completed") continue;
      artifacts.push(...(await this.artifacts(context, runId)));
      for (const evidence of await this.dependencies.runs.evidence(context, runId))
        tables.set(evidence.evidence_id, evidence);
    }
    return conversationExportContentSchema.parse({
      kind: "conversation",
      conversation_id: detail.conversation.id,
      title: detail.conversation.title,
      messages: messages.map((message) => ({
        message_id: message.id,
        role: message.role,
        sequence: message.sequence,
        content: message.content,
        created_at: runTime(message.createdAt),
        ...(message.analysisRunId ? { analysis_run_id: message.analysisRunId } : {}),
      })),
      runs,
      artifacts,
      tables: [...tables.values()].map((evidence) => this.exportEvidence(evidence)),
    });
  }
  private exportEvidence(evidence: QueryEvidence) {
    return {
      evidence,
      availability: evidence.result.truncated ? ("truncated" as const) : ("complete" as const),
    };
  }
  private async summary(context: AuthContext, id: string): Promise<ReportSummary | null> {
    const definition = await this.optional(() => this.dependencies.definitions.get(context, id));
    const snapshot = await this.optional(() => this.dependencies.reports.get(context, id));
    if (!definition && !snapshot) return null;
    const blocks = definition
      ? definition.definition.presentation.flatMap((section) => section.blocks)
      : snapshot!.sections.flatMap((section) => section.blocks);
    const data = blocks.filter((block) => block.type !== "text");
    const first = data[0];
    return reportSummarySchema.parse({
      report_id: id,
      title: definition?.definition.title ?? snapshot!.title,
      user_id: definition?.user_id ?? snapshot!.user_id,
      created_at: definition?.created_at ?? snapshot!.created_at,
      updated_at: [definition?.created_at, snapshot?.created_at]
        .filter((time): time is string => !!time)
        .sort((left, right) => dayjs(left).valueOf() - dayjs(right).valueOf())
        .at(-1),
      description: definition?.definition.description ?? snapshot?.description,
      display_type:
        data.length === 1 ? (first?.type === "chart" ? first.chart?.type : "table") : "legacy",
      shared_with: definition?.shared_with ?? snapshot!.shared_with,
      ...(definition ? { definition_version: definition.version } : {}),
      ...(snapshot ? { snapshot_version: snapshot.version } : {}),
    });
  }
  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }
  private hidden(error: unknown): boolean {
    return (
      error instanceof ApplicationError &&
      [
        "NOT_FOUND",
        "UNAUTHORIZED",
        "UNAUTHORIZED_OBJECT",
        "UNAUTHORIZED_COLUMN",
        "POLICY_REJECTED",
        "CONFLICT",
      ].includes(error.code)
    );
  }
}
export { ReportManagementService };
