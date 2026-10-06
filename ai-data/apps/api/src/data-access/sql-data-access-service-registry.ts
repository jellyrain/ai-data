import dayjs from "dayjs";
import { z } from "zod";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import {
  sourceHealthSchema,
  type DataAccessHeartbeat,
  type SourceHealth,
} from "@ai-data/contracts";

import type { DataAccessServiceRegistration, DataAccessServiceRegistry } from "./data-access-types";
import { parseStoredRecord } from "../metadata/parse-stored-record";

/** API 元数据库中的 DAS 服务注册记录。 */
type DataAccessServiceRow = {
  /** 心跳上报的实例主键。 */
  service_id: string;
  /** API 根据 TCP 来源地址及上报端口组合的回调 URL。 */
  service_url: string;
  /** 心跳附带的版本，未上报时为 null。 */
  service_version: string | null;
  /** 实例级状态，数据源状态另存于快照。 */
  status: "healthy" | "unhealthy";
  /** API 接收最近心跳的时间。 */
  last_heartbeat_at: Date;
  /** 心跳附带的诊断信息，未上报时为 null。 */
  message: string | null;
  /** 数据源健康快照 JSON，读取时重新校验每一项。 */
  sources_json: string;
};

/** 将 DAS 心跳持久化到 API 元数据库，并按失联阈值筛选实例。 */
class SqlDataAccessServiceRegistry implements DataAccessServiceRegistry {
  /** 默认失联窗口为 90 秒，SQL 按数据库当前时间筛选最近接收的心跳。 */
  constructor(
    private readonly database: MetadataQueryExecutor,
    private readonly heartbeatTtlMilliseconds = 90_000,
  ) {}

  /** 管理查询保留所有历史注册行，按与执行发现相同的失联窗口计算。 */
  async listRegisteredServices() {
    const result = await this.database.execute({
      sql: `SELECT service_id,service_url,service_version,status,last_heartbeat_at,message,sources_json,
       CAST(CASE WHEN last_heartbeat_at > DATEADD(millisecond,@negative_ttl,SYSUTCDATETIME()) THEN 0 ELSE 1 END AS BIT) AS is_expired
       FROM dbo.data_access_services ORDER BY service_id`,
      parameters: [
        { name: "negative_ttl", type: "integer", value: -this.heartbeatTtlMilliseconds },
      ],
    });
    const rows = parseStoredRecord(() =>
      z
        .array(
          z
            .object({
              service_id: z.string().min(1),
              service_url: z.string().url(),
              service_version: z.string().nullable(),
              status: z.enum(["healthy", "unhealthy"]),
              last_heartbeat_at: z.date(),
              message: z.string().nullable(),
              sources_json: z.string(),
              is_expired: z.boolean(),
            })
            .strict(),
        )
        .parse(result.rows),
    );
    return rows.map((row) => ({
      serviceId: row.service_id,
      serviceUrl: row.service_url,
      serviceVersion: row.service_version,
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at,
      message: row.message,
      sources: parseStoredRecord(() =>
        sourceHealthSchema.array().parse(JSON.parse(row.sources_json)),
      ),
      isExpired: row.is_expired,
    }));
  }

  /** 使用服务主键幂等更新 API 推导的调用地址和最新数据源健康快照。 */
  async registerHeartbeat(
    heartbeat: DataAccessHeartbeat,
    serviceUrl: string,
  ): Promise<DataAccessServiceRegistration> {
    const now = dayjs().toDate();
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

  /** 由 SQL 筛选窗口内的健康实例，再校验存储快照；损坏记录通过内部错误出口报告。 */
  async listHealthyServices(): Promise<DataAccessServiceRegistration[]> {
    const result = await this.database.execute<DataAccessServiceRow>({
      sql: "SELECT service_id, service_url, service_version, status, last_heartbeat_at, message, sources_json FROM dbo.data_access_services WHERE status = 'healthy' AND last_heartbeat_at > DATEADD(millisecond, @negative_ttl, SYSUTCDATETIME()) ORDER BY service_id",
      parameters: [
        { name: "negative_ttl", type: "integer", value: -this.heartbeatTtlMilliseconds },
      ],
    });
    return parseStoredRecord(() =>
      result.rows.map((row) => ({
        serviceId: row.service_id,
        serviceUrl: row.service_url,
        serviceVersion: row.service_version,
        status: row.status,
        lastHeartbeatAt: row.last_heartbeat_at,
        message: row.message,
        sources: sourceHealthSchema.array().parse(JSON.parse(row.sources_json)),
      })),
    );
  }
}

export { SqlDataAccessServiceRegistry };
