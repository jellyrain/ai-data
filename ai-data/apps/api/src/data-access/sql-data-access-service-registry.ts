import type { MetadataQueryExecutor } from "@ai-data/metadata";
import {
  sourceHealthSchema,
  type DataAccessHeartbeat,
  type SourceHealth,
} from "@ai-data/contracts";

import type { DataAccessServiceRegistration, DataAccessServiceRegistry } from "./data-access-types";

/** API 元数据库中的 DAS 服务注册记录。 */
type DataAccessServiceRow = {
  service_id: string;
  service_url: string;
  service_version: string | null;
  status: "healthy" | "unhealthy";
  last_heartbeat_at: Date;
  message: string | null;
  sources_json: string;
};

/** 将 DAS 心跳持久化到 API 元数据库，并按失联阈值筛选实例。 */
class SqlDataAccessServiceRegistry implements DataAccessServiceRegistry {
  constructor(
    private readonly database: MetadataQueryExecutor,
    private readonly heartbeatTtlMilliseconds = 90_000,
  ) {}

  /** 使用服务主键幂等更新 API 推导的调用地址和最新数据源健康快照。 */
  async registerHeartbeat(
    heartbeat: DataAccessHeartbeat,
    serviceUrl: string,
  ): Promise<DataAccessServiceRegistration> {
    const now = new Date();
    await this.database.execute({
      sql: `
        UPDATE dbo.data_access_services
        SET service_url = @service_url,
            service_version = @service_version,
            status = @status,
            last_heartbeat_at = @last_heartbeat_at,
            message = @message,
            sources_json = @sources_json
        WHERE service_id = @service_id;
        IF @@ROWCOUNT = 0
          INSERT INTO dbo.data_access_services
            (service_id, service_url, service_version, status, last_heartbeat_at, message, sources_json)
          VALUES
            (@service_id, @service_url, @service_version, @status, @last_heartbeat_at, @message, @sources_json);`,
      parameters: [
        { name: "service_id", type: "string", value: heartbeat.service_id },
        { name: "service_url", type: "string", value: serviceUrl },
        { name: "service_version", type: "string", value: heartbeat.service_version ?? null },
        { name: "status", type: "string", value: heartbeat.status },
        { name: "last_heartbeat_at", type: "date", value: now },
        { name: "message", type: "string", value: heartbeat.message ?? null },
        { name: "sources_json", type: "string", value: JSON.stringify(heartbeat.sources) },
      ],
    });
    return {
      serviceId: heartbeat.service_id,
      serviceUrl,
      serviceVersion: heartbeat.service_version ?? null,
      status: heartbeat.status,
      lastHeartbeatAt: now,
      message: heartbeat.message ?? null,
      sources: heartbeat.sources as SourceHealth[],
    };
  }

  /** 查询全部注册记录，并过滤服务状态和心跳超时实例。 */
  async listHealthyServices(): Promise<DataAccessServiceRegistration[]> {
    const result = await this.database.execute<DataAccessServiceRow>({
      sql: "SELECT service_id, service_url, service_version, status, last_heartbeat_at, message, sources_json FROM dbo.data_access_services WHERE status = 'healthy' AND last_heartbeat_at > DATEADD(millisecond, @negative_ttl, SYSUTCDATETIME()) ORDER BY service_id",
      parameters: [
        { name: "negative_ttl", type: "integer", value: -this.heartbeatTtlMilliseconds },
      ],
    });
    return result.rows.flatMap((row) => {
      try {
        const sources = JSON.parse(row.sources_json) as unknown;
        if (!Array.isArray(sources)) return [];
        const parsedSources = sources.flatMap((source) => {
          const parsed = sourceHealthSchema.safeParse(source);
          return parsed.success ? [parsed.data] : [];
        });
        return [
          {
            serviceId: row.service_id,
            serviceUrl: row.service_url,
            serviceVersion: row.service_version,
            status: row.status,
            lastHeartbeatAt: row.last_heartbeat_at,
            message: row.message,
            sources: parsedSources as SourceHealth[],
          },
        ];
      } catch {
        return [];
      }
    });
  }
}

export { SqlDataAccessServiceRegistry };
