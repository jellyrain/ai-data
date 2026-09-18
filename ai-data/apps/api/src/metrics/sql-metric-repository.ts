import { metricDefinitionSchema, stableStringify, type MetricDefinition } from "@ai-data/contracts";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { MetricRepository } from "./metric-types";

class SqlMetricRepository implements MetricRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async publish(organizationId: string, metric: MetricDefinition): Promise<void> {
    await this.database.transaction(async (executor) => {
      const parameters = [
        { name: "org", type: "string" as const, value: organizationId },
        { name: "id", type: "string" as const, value: metric.metric_id },
      ];
      const existing = await executor.execute({
        sql: "SELECT TOP (1) definition_json FROM dbo.metric_definitions WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND metric_id=@id ORDER BY version DESC",
        parameters,
      });
      const previous = existing.rows[0]
        ? parseStoredRecord(() =>
            metricDefinitionSchema.parse(
              JSON.parse(String(existing.rows[0].definition_json)) as unknown,
            ),
          )
        : null;
      if (metric.version !== (previous?.version ?? 0) + 1)
        throw new ApplicationError("CONFLICT", "指标版本必须顺序递增，已发布版本不可改写");
      if (
        previous &&
        (stableStringify(previous.date_basis) !== stableStringify(metric.date_basis) ||
          previous.query.source_id !== metric.query.source_id ||
          previous.query.from.object_id !== metric.query.from.object_id)
      )
        throw new ApplicationError("INVALID_INPUT", "更换指标时间依据或来源时应使用独立指标标识");
      await executor.execute({
        sql: "INSERT INTO dbo.metric_definitions (organization_id,metric_id,version,definition_json) VALUES (@org,@id,@version,@json)",
        parameters: [
          ...parameters,
          { name: "version", type: "integer", value: metric.version },
          { name: "json", type: "string", value: JSON.stringify(metric) },
        ],
      });
    });
  }
  async find(
    organizationId: string,
    metricId: string,
    version?: number,
  ): Promise<MetricDefinition | null> {
    const result = await this.database.execute({
      sql: "SELECT TOP (1) definition_json FROM dbo.metric_definitions WHERE organization_id=@org AND metric_id=@id AND (@version IS NULL OR version=@version) ORDER BY version DESC",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: metricId },
        { name: "version", type: "integer", value: version ?? null },
      ],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          metricDefinitionSchema.parse(
            JSON.parse(String(result.rows[0].definition_json)) as unknown,
          ),
        )
      : null;
  }
  async list(organizationId: string): Promise<MetricDefinition[]> {
    const result = await this.database.execute({
      sql: "SELECT definition_json FROM (SELECT definition_json, ROW_NUMBER() OVER (PARTITION BY metric_id ORDER BY version DESC) AS ordinal FROM dbo.metric_definitions WHERE organization_id=@org) versions WHERE ordinal=1",
      parameters: [{ name: "org", type: "string", value: organizationId }],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() =>
        metricDefinitionSchema.parse(JSON.parse(String(row.definition_json)) as unknown),
      ),
    );
  }
}
export { SqlMetricRepository };
