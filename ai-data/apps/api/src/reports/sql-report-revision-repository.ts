import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import {
  reportDefinitionSchema,
  reportNarrativeSchema,
  type ReportDefinition,
  type ReportNarrative,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { SqlConversationRepository } from "../conversations/sql-conversation-repository";
import { reportEditContextSchema } from "./report-revision-records";
import type { ReportEditContext, ReportRevisionRepository } from "./report-revision-types";

/** 报表编辑上下文与消息、分析运行、派发记录在同一事务创建。 */
class SqlReportRevisionRepository implements ReportRevisionRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async create(
    context: AuthContext,
    target: ReportEditContext,
    prompt: string,
    key: string,
    hash: string,
    agent: { agentId: string; agentVersion: number },
  ) {
    return this.database.transaction(async (executor) => {
      const parameters = [
        ...identity(context),
        { name: "report", type: "string" as const, value: target.report_id },
        { name: "key", type: "string" as const, value: key },
      ];
      const prior = await executor.execute({
        sql: "SELECT request_hash,conversation_id,analysis_run_id FROM dbo.report_revision_requests WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND user_id=@user AND report_id=@report AND idempotency_key=@key",
        parameters,
      });
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash)
          throw new ApplicationError("CONFLICT", "修改操作键已用于其他内容");
        return {
          conversation_id: String(prior.rows[0].conversation_id),
          analysis_run_id: String(prior.rows[0].analysis_run_id),
        };
      }
      if (target.mode === "revision") {
        const head = await executor.execute({
          sql: "SELECT version,user_id FROM dbo.report_templates WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND report_id=@report",
          parameters: identity(context)
            .filter((p) => p.name === "org")
            .concat({ name: "report", type: "string", value: target.report_id }),
        });
        if (
          !head.rows[0] ||
          head.rows[0].user_id !== context.userId ||
          Number(head.rows[0].version) !== target.expected_version
        )
          throw new ApplicationError("CONFLICT", "报表已更新或不可编辑");
      }
      const conversations = new SqlConversationRepository({
        execute: executor.execute.bind(executor),
        transaction: (operation) => operation(executor),
      });
      const id = randomUUID(),
        now = dayjs().toDate();
      await conversations.createConversation({
        id,
        organizationId: context.organizationId,
        userId: context.userId,
        title: target.mode === "revision" ? "报表修改" : "报表分析说明",
        status: "active",
        createdAt: now,
        updatedAt: now,
        ...agent,
      });
      const submission = await conversations.submitMessage(
        id,
        context.userId,
        context.organizationId,
        prompt,
        key,
        context.sessionId,
      );
      if (!submission) throw new ApplicationError("INTERNAL_ERROR", "无法创建报表对话");
      await this.initialize(context, submission.analysisRun.id, target, executor);
      await executor.execute({
        sql: "INSERT INTO dbo.report_revision_requests(organization_id,user_id,report_id,idempotency_key,request_hash,conversation_id,analysis_run_id) VALUES(@org,@user,@report,@key,@hash,@conversation,@run)",
        parameters: [
          ...parameters,
          { name: "hash", type: "string", value: hash },
          { name: "conversation", type: "string", value: id },
          { name: "run", type: "string", value: submission.analysisRun.id },
        ],
      });
      return { conversation_id: id, analysis_run_id: submission.analysisRun.id };
    });
  }
  async get(
    context: AuthContext,
    runId: string,
    executor: MetadataQueryExecutor = this.database,
  ): Promise<ReportEditContext | null> {
    const result = await executor.execute({
      sql: "SELECT context_json FROM dbo.analysis_report_contexts WHERE analysis_run_id=@run AND organization_id=@org AND user_id=@user",
      parameters: [...identity(context), { name: "run", type: "string", value: runId }],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          reportEditContextSchema.parse(JSON.parse(String(result.rows[0].context_json))),
        )
      : null;
  }
  async initialize(
    context: AuthContext,
    runId: string,
    target: ReportEditContext,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    const value = reportEditContextSchema.parse(target);
    await executor.execute({
      sql: "INSERT INTO dbo.analysis_report_contexts(analysis_run_id,organization_id,user_id,report_id,expected_version,context_json) VALUES(@run,@org,@user,@report,@version,@json)",
      parameters: [
        ...identity(context),
        { name: "run", type: "string", value: runId },
        { name: "report", type: "string", value: value.report_id },
        { name: "version", type: "integer", value: value.expected_version },
        { name: "json", type: "string", value: JSON.stringify(value) },
      ],
    });
  }
  async stage(
    context: AuthContext,
    runId: string,
    input: ReportDefinition,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    const definition = reportDefinitionSchema.parse(input);
    await executor.execute({
      sql: "UPDATE dbo.analysis_report_contexts SET staged_definition_json=@json WHERE analysis_run_id=@run AND organization_id=@org AND user_id=@user",
      parameters: [
        ...identity(context),
        { name: "run", type: "string", value: runId },
        { name: "json", type: "string", value: JSON.stringify(definition) },
      ],
    });
  }
  async staged(
    context: AuthContext,
    runId: string,
    executor: MetadataQueryExecutor,
  ): Promise<ReportDefinition | null> {
    const result = await executor.execute({
      sql: "SELECT staged_definition_json FROM dbo.analysis_report_contexts WHERE analysis_run_id=@run AND organization_id=@org AND user_id=@user",
      parameters: [...identity(context), { name: "run", type: "string", value: runId }],
    });
    return result.rows[0]?.staged_definition_json
      ? parseStoredRecord(() =>
          reportDefinitionSchema.parse(JSON.parse(String(result.rows[0].staged_definition_json))),
        )
      : null;
  }
  async saveNarrative(
    context: AuthContext,
    narrative: ReportNarrative,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    const record = reportNarrativeSchema.parse(narrative);
    await executor.execute({
      sql: "INSERT INTO dbo.report_narratives(organization_id,execution_id,analysis_run_id,record_json) VALUES(@org,@execution,@run,@json)",
      parameters: [
        { name: "org", type: "string", value: context.organizationId },
        { name: "execution", type: "string", value: record.execution_id },
        { name: "run", type: "string", value: record.analysis_run_id },
        { name: "json", type: "string", value: JSON.stringify(record) },
      ],
    });
  }
  async narratives(context: AuthContext, executionId: string): Promise<ReportNarrative[]> {
    const result = await this.database.execute({
      sql: "SELECT record_json FROM dbo.report_narratives WHERE organization_id=@org AND execution_id=@execution ORDER BY analysis_run_id",
      parameters: [
        { name: "org", type: "string", value: context.organizationId },
        { name: "execution", type: "string", value: executionId },
      ],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() => reportNarrativeSchema.parse(JSON.parse(String(row.record_json)))),
    );
  }
}
/** 运行上下文只能由所属组织账号访问。 */
function identity(context: AuthContext) {
  return [
    { name: "org", type: "string" as const, value: context.organizationId },
    { name: "user", type: "string" as const, value: context.userId },
  ];
}
export { SqlReportRevisionRepository };
