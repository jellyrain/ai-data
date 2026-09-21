import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import {
  reportExecutionSchema,
  savedReportSchema,
  type ReportDefinitionVersion,
  type ReportExecution,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { insertAnalysisRun } from "../analysis-runs/analysis-run-records";
import { runTime, runTimeMilliseconds } from "../analysis-runs/run-time";
import type { ReportExecutionRepository } from "./report-execution-types";
import { persistReportArtifact } from "./report-artifact";

/** 执行操作键使用数据库范围锁串行认领，业务查询不持有元数据事务。 */
class SqlReportExecutionRepository implements ReportExecutionRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  async findOperation(context: AuthContext, reportId: string, key: string) {
    const result = await this.database.execute({
      sql: "SELECT request_hash,record_json FROM dbo.report_executions WHERE organization_id=@org AND user_id=@user AND report_id=@report AND idempotency_key=@key",
      parameters: [
        ...identity(context),
        { name: "report", type: "string", value: reportId },
        { name: "key", type: "string", value: key },
      ],
    });
    return result.rows[0]
      ? {
          record: parseRecord(result.rows[0].record_json),
          requestHash: String(result.rows[0].request_hash),
        }
      : null;
  }

  async start(
    context: AuthContext,
    reportId: string,
    requestHash: string,
    key: string,
    definition: ReportDefinitionVersion,
    parameters: ReportExecution["parameters"],
    deadline: string,
  ) {
    return this.database.transaction(async (executor) => {
      const keys = [
        ...identity(context),
        { name: "report", type: "string" as const, value: reportId },
        { name: "key", type: "string" as const, value: key },
      ];
      const prior = await executor.execute({
        sql: "SELECT request_hash,record_json FROM dbo.report_executions WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND user_id=@user AND report_id=@report AND idempotency_key=@key",
        parameters: keys,
      });
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new ApplicationError("CONFLICT", "执行操作键已用于其他请求");
        return { record: parseRecord(prior.rows[0].record_json), isNew: false };
      }
      const executionId = randomUUID(),
        runId = randomUUID(),
        conversationId = randomUUID();
      const now = dayjs();
      await executor.execute({
        sql: "INSERT INTO dbo.conversations(id,organization_id,user_id,title,status,created_at,updated_at) VALUES(@id,@org,@user,@title,'active',@now,@now)",
        parameters: [
          ...identity(context),
          { name: "id", type: "string", value: conversationId },
          { name: "title", type: "string", value: definition.definition.title },
          { name: "now", type: "date", value: now.toDate() },
        ],
      });
      await insertAnalysisRun(executor, {
        id: runId,
        conversationId,
        organizationId: context.organizationId,
        userId: context.userId,
        status: "created",
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: now.toDate(),
      });
      const record = reportExecutionSchema.parse({
        execution_id: executionId,
        report_id: reportId,
        organization_id: context.organizationId,
        user_id: context.userId,
        definition_version: definition.version,
        definition: definition.definition,
        parameters,
        status: "running",
        analysis_run_id: runId,
        lease_epoch: 1,
        deadline,
        created_at: runTime(now),
        results: [],
      });
      await executor.execute({
        sql: "INSERT INTO dbo.report_executions(organization_id,execution_id,report_id,user_id,idempotency_key,request_hash,status,lease_epoch,deadline,record_json) VALUES(@org,@id,@report,@user,@key,@hash,'running',1,@deadline,@json)",
        parameters: [
          ...keys,
          { name: "id", type: "string", value: executionId },
          { name: "hash", type: "string", value: requestHash },
          { name: "deadline", type: "date", value: dayjs(runTimeMilliseconds(deadline)).toDate() },
          { name: "json", type: "string", value: JSON.stringify(record) },
        ],
      });
      return { record, isNew: true };
    });
  }

  async find(
    context: AuthContext,
    executionId: string,
    executor: MetadataQueryExecutor = this.database,
  ): Promise<ReportExecution | null> {
    const result = await executor.execute({
      sql: "SELECT record_json FROM dbo.report_executions WHERE organization_id=@org AND execution_id=@id",
      parameters: [
        { name: "org", type: "string", value: context.organizationId },
        { name: "id", type: "string", value: executionId },
      ],
    });
    return result.rows[0] ? parseRecord(result.rows[0].record_json) : null;
  }

  async finish(
    context: AuthContext,
    input: ReportExecution,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportExecution> {
    if (!executor) return this.database.transaction((tx) => this.finish(context, input, tx));
    let record = reportExecutionSchema.parse(input);
    const keys = [
      { name: "org", type: "string" as const, value: context.organizationId },
      { name: "id", type: "string" as const, value: record.execution_id },
    ];
    const result = await executor.execute({
      sql: "SELECT record_json FROM dbo.report_executions WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND execution_id=@id",
      parameters: keys,
    });
    if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", "报表执行不存在");
    const previous = parseRecord(result.rows[0].record_json);
    if (previous.status !== "running") {
      if (record.status === "completed" && previous.status !== "completed")
        throw new ApplicationError("CONFLICT", "报表执行已经结束");
      return previous;
    }
    if (
      previous.lease_epoch !== record.lease_epoch ||
      previous.report_id !== record.report_id ||
      previous.user_id !== record.user_id
    )
      throw new ApplicationError("CONFLICT", "报表执行代次已失效");
    if (record.status === "completed") {
      if (dayjs().valueOf() >= runTimeMilliseconds(previous.deadline))
        throw new ApplicationError("QUERY_TIMEOUT", "报表执行已过期");
      const versions = await executor.execute({
        sql: "SELECT COALESCE(MAX(version),0)+1 AS version FROM dbo.saved_reports WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND report_id=@report",
        parameters: [keys[0], { name: "report", type: "string", value: record.report_id }],
      });
      const snapshot = savedReportSchema.parse({
        ...record.snapshot,
        version: Number(versions.rows[0].version),
      });
      await executor.execute({
        sql: "INSERT INTO dbo.saved_reports(organization_id,report_id,version,user_id,report_json) VALUES(@org,@report,@version,@user,@json)",
        parameters: [
          keys[0],
          { name: "report", type: "string", value: record.report_id },
          { name: "version", type: "integer", value: snapshot.version },
          { name: "user", type: "string", value: record.user_id },
          { name: "json", type: "string", value: JSON.stringify(snapshot) },
        ],
      });
      record = { ...record, snapshot };
      await persistReportArtifact(executor, snapshot);
    }
    await executor.execute({
      sql: "UPDATE dbo.report_executions SET status=@status,record_json=@json WHERE organization_id=@org AND execution_id=@id",
      parameters: [
        ...keys,
        { name: "status", type: "string", value: record.status },
        { name: "json", type: "string", value: JSON.stringify(record) },
      ],
    });
    return record;
  }
}
/** JSON 结构错误属于持久化损坏，不作为调用方输入错误返回。 */
function parseRecord(value: unknown): ReportExecution {
  return parseStoredRecord(() => reportExecutionSchema.parse(JSON.parse(String(value)) as unknown));
}
/** 执行操作键同时绑定组织和当前用户。 */
function identity(context: AuthContext) {
  return [
    { name: "org", type: "string" as const, value: context.organizationId },
    { name: "user", type: "string" as const, value: context.userId },
  ];
}
export { SqlReportExecutionRepository };
