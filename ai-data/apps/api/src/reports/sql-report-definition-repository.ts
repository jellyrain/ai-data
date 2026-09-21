import { randomUUID } from "node:crypto";
import {
  analysisRunSchema,
  queryEvidenceSchema,
  reportDefinitionVersionSchema,
  reusableReportBlockSchema,
  savedReportSchema,
  type QueryEvidence,
  type SaveReportDefinitionInput,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { runTime } from "../analysis-runs/run-time";
import type {
  DefinitionKind,
  DefinitionRecord,
  DefinitionRepository,
} from "./report-definition-types";
import { reportArtifactRecordSchema } from "./report-artifact-record";

/** 表名只来自固定领域映射，所有业务值均使用参数绑定。 */
const tables = {
  report: {
    head: "dbo.report_templates",
    versions: "dbo.report_template_versions",
    id: "report_id",
  },
  block: { head: "dbo.report_blocks", versions: "dbo.report_block_versions", id: "block_id" },
};
/** 定义写入在头记录锁内生成版本；外部事务可用于分析完成时的原子提交。 */
class SqlReportDefinitionRepository implements DefinitionRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async transaction<T>(
    operation: (executor: MetadataQueryExecutor) => Promise<T>,
    executor?: MetadataQueryExecutor,
  ): Promise<T> {
    return executor ? operation(executor) : this.database.transaction(operation);
  }
  async find(
    kind: DefinitionKind,
    organizationId: string,
    id: string,
    version?: number,
    executor: MetadataQueryExecutor = this.database,
  ): Promise<DefinitionRecord | null> {
    const table = tables[kind];
    const result = await executor.execute({
      sql: `SELECT record_json FROM ${version === undefined ? table.head : table.versions} WHERE organization_id=@org AND ${table.id}=@id${version === undefined ? "" : " AND version=@version"}`,
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: id },
        ...(version === undefined
          ? []
          : [{ name: "version", type: "integer" as const, value: version }]),
      ],
    });
    return result.rows[0] ? this.parse(kind, result.rows[0].record_json) : null;
  }
  async save(
    kind: DefinitionKind,
    context: AuthContext,
    input: SaveReportDefinitionInput,
    id?: string,
    expectedVersion?: number,
    executor?: MetadataQueryExecutor,
  ): Promise<DefinitionRecord> {
    return this.transaction(async (transaction) => {
      const table = tables[kind];
      const key = id ?? randomUUID();
      const parameters = [
        { name: "org", type: "string" as const, value: context.organizationId },
        { name: "id", type: "string" as const, value: key },
      ];
      const found = await transaction.execute({
        sql: `SELECT record_json FROM ${table.head} WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND ${table.id}=@id`,
        parameters,
      });
      const previous = found.rows[0] ? this.parse(kind, found.rows[0].record_json) : null;
      if (expectedVersion === 0 && previous)
        throw new ApplicationError("CONFLICT", "报表定义标识已存在");
      if (
        id &&
        ((!previous && expectedVersion !== 0) || (previous && previous.user_id !== context.userId))
      )
        throw new ApplicationError("NOT_FOUND", "报表定义不存在或不可修改");
      if (previous && previous.version !== expectedVersion)
        throw new ApplicationError("CONFLICT", "报表定义已更新，请重新读取");
      const record = this.parse(
        kind,
        JSON.stringify({
          ...input,
          [table.id]: key,
          organization_id: context.organizationId,
          user_id: context.userId,
          version: (previous?.version ?? 0) + 1,
          created_at: runTime(),
        }),
      );
      const write = [
        ...parameters,
        { name: "user", type: "string" as const, value: context.userId },
        { name: "version", type: "integer" as const, value: record.version },
        { name: "json", type: "string" as const, value: JSON.stringify(record) },
      ];
      await transaction.execute({
        sql: previous
          ? `UPDATE ${table.head} SET version=@version,record_json=@json,updated_at=SYSUTCDATETIME() WHERE organization_id=@org AND ${table.id}=@id`
          : `INSERT INTO ${table.head} (organization_id,${table.id},user_id,version,record_json) VALUES (@org,@id,@user,@version,@json)`,
        parameters: write,
      });
      await transaction.execute({
        sql: `INSERT INTO ${table.versions} (organization_id,${table.id},version,record_json) VALUES (@org,@id,@version,@json)`,
        parameters: write,
      });
      return record;
    }, executor);
  }
  async list(
    kind: DefinitionKind,
    organizationId: string,
    after: string | undefined,
    limit: number,
  ): Promise<DefinitionRecord[]> {
    const table = tables[kind];
    const result = await this.database.execute({
      sql: `SELECT TOP (@limit) record_json FROM ${table.head} WHERE organization_id=@org AND (@after IS NULL OR ${table.id}>@after) ORDER BY ${table.id}`,
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "after", type: "string", value: after ?? null },
        { name: "limit", type: "integer", value: limit },
      ],
    });
    return result.rows.map((row) => this.parse(kind, row.record_json));
  }
  async versions(
    kind: DefinitionKind,
    organizationId: string,
    id: string,
  ): Promise<DefinitionRecord[]> {
    const table = tables[kind];
    const result = await this.database.execute({
      sql: `SELECT record_json FROM ${table.versions} WHERE organization_id=@org AND ${table.id}=@id ORDER BY version DESC`,
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: id },
      ],
    });
    return result.rows.map((row) => this.parse(kind, row.record_json));
  }
  async assertActiveUsers(
    organizationId: string,
    users: string[],
    executor: MetadataQueryExecutor = this.database,
  ): Promise<void> {
    if (new Set(users).size !== users.length)
      throw new ApplicationError("INVALID_INPUT", "分享账号不能重复");
    for (const user of users) {
      const result = await executor.execute({
        sql: "SELECT id FROM dbo.users WHERE id=@id AND organization_id=@org AND status='active'",
        parameters: [
          { name: "id", type: "string", value: user },
          { name: "org", type: "string", value: organizationId },
        ],
      });
      if (!result.rows.length)
        throw new ApplicationError("INVALID_INPUT", "分享账号必须是同一组织内的活跃账号");
    }
  }
  async source(
    context: AuthContext,
    runId: string,
    requireOwner: boolean,
    executor: MetadataQueryExecutor = this.database,
    artifactId?: string,
  ): Promise<QueryEvidence[]> {
    const parameters = [
      { name: "run", type: "string" as const, value: runId },
      { name: "org", type: "string" as const, value: context.organizationId },
      { name: "user", type: "string" as const, value: context.userId },
      { name: "owner", type: "boolean" as const, value: requireOwner },
    ];
    const run = await executor.execute({
      sql: "SELECT s.state_json FROM dbo.analysis_runs r JOIN dbo.analysis_run_states s ON s.analysis_run_id=r.id WHERE r.id=@run AND r.organization_id=@org AND (@owner=0 OR r.user_id=@user)",
      parameters,
    });
    if (!run.rows[0]) throw new ApplicationError("NOT_FOUND", "来源运行不存在");
    const state = parseStoredRecord(() =>
      analysisRunSchema.parse(JSON.parse(String(run.rows[0].state_json)) as unknown),
    );
    if (state.status !== "completed")
      throw new ApplicationError("CONFLICT", "来源运行尚未成功完成");
    if (artifactId) {
      const result = await executor.execute({
        sql: "SELECT a.record_json,r.report_json FROM dbo.analysis_artifacts a JOIN dbo.saved_reports r ON r.organization_id=a.organization_id AND r.report_id=JSON_VALUE(a.record_json,'$.report_id') AND r.version=TRY_CONVERT(INT,JSON_VALUE(a.record_json,'$.report_version')) WHERE a.organization_id=@org AND a.analysis_run_id=@run AND a.artifact_id=@artifact",
        parameters: [...parameters, { name: "artifact", type: "string", value: artifactId }],
      });
      if (!result.rows[0]) throw new ApplicationError("INVALID_INPUT", "来源产物不属于当前运行");
      const artifact = parseStoredRecord(() =>
        reportArtifactRecordSchema.parse(JSON.parse(String(result.rows[0].record_json)) as unknown),
      );
      const report = parseStoredRecord(() =>
        savedReportSchema.parse(JSON.parse(String(result.rows[0].report_json)) as unknown),
      );
      if (artifact.analysis_run_id !== runId || report.analysis_run_id !== runId)
        throw new ApplicationError("INTERNAL_ERROR", "产物来源记录不一致");
      return report.sources;
    }
    const evidence = await executor.execute({
      sql: "SELECT evidence_json FROM dbo.analysis_evidence WHERE analysis_run_id=@run ORDER BY evidence_id",
      parameters,
    });
    return evidence.rows.map((row) =>
      parseStoredRecord(() =>
        queryEvidenceSchema.parse(JSON.parse(String(row.evidence_json)) as unknown),
      ),
    );
  }
  private parse(kind: DefinitionKind, value: unknown): DefinitionRecord {
    return parseStoredRecord(() =>
      (kind === "report" ? reportDefinitionVersionSchema : reusableReportBlockSchema).parse(
        JSON.parse(String(value)) as unknown,
      ),
    );
  }
}
export { SqlReportDefinitionRepository };
