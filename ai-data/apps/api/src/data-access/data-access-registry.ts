import type { DataAccessHeartbeat, SourceHealth } from "@ai-data/contracts";

import type { DataAccessServiceRegistration, DataAccessServiceRegistry } from "./data-access-types";

/** 在 API 进程内维护 DAS 最近心跳，便于先完成对接闭环。 */
class InMemoryDataAccessServiceRegistry implements DataAccessServiceRegistry {
  private readonly services = new Map<string, DataAccessServiceRegistration>();

  constructor(private readonly heartbeatTtlMilliseconds = 90_000) {}

  /** 保存 DAS 心跳、API 推导的调用地址及其数据源健康快照。 */
  async registerHeartbeat(
    heartbeat: DataAccessHeartbeat,
    serviceUrl: string,
  ): Promise<DataAccessServiceRegistration> {
    const registration: DataAccessServiceRegistration = {
      serviceId: heartbeat.service_id,
      serviceUrl,
      serviceVersion: heartbeat.service_version ?? null,
      status: heartbeat.status,
      lastHeartbeatAt: new Date(),
      message: heartbeat.message ?? null,
      sources: heartbeat.sources as SourceHealth[],
    };
    this.services.set(registration.serviceId, registration);
    return registration;
  }

  /** 过滤服务级状态和心跳过期的 DAS 实例。 */
  async listHealthyServices(): Promise<DataAccessServiceRegistration[]> {
    const cutoff = Date.now() - this.heartbeatTtlMilliseconds;
    return [...this.services.values()].filter(
      (service) => service.status === "healthy" && service.lastHeartbeatAt.getTime() > cutoff,
    );
  }
}

export { InMemoryDataAccessServiceRegistry };
