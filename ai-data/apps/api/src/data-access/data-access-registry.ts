import dayjs from "dayjs";
import type { DataAccessHeartbeat, SourceHealth } from "@ai-data/contracts";

import type { DataAccessServiceRegistration, DataAccessServiceRegistry } from "./data-access-types";

/** 进程内 DAS 心跳注册表，适用于隔离测试与临时实例；重启后记录清空。 */
class InMemoryDataAccessServiceRegistry implements DataAccessServiceRegistry {
  private readonly services = new Map<string, DataAccessServiceRegistration>();

  /** 默认以 90 秒为失联窗口，按 API 收到心跳的时间判断。 */
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
      lastHeartbeatAt: dayjs().toDate(),
      message: heartbeat.message ?? null,
      sources: heartbeat.sources as SourceHealth[],
    };
    this.services.set(registration.serviceId, registration);
    return registration;
  }

  /** 过滤服务级状态和心跳过期的 DAS 实例。 */
  async listRegisteredServices() {
    const cutoff = dayjs().subtract(this.heartbeatTtlMilliseconds, "millisecond");
    return [...this.services.values()].map((service) => ({
      ...service,
      isExpired: !dayjs(service.lastHeartbeatAt).isAfter(cutoff),
    }));
  }

  /** 过滤服务级状态和心跳过期的 DAS 实例。 */
  async listHealthyServices(): Promise<DataAccessServiceRegistration[]> {
    const cutoff = dayjs().subtract(this.heartbeatTtlMilliseconds, "millisecond");
    return [...this.services.values()].filter(
      (service) => service.status === "healthy" && dayjs(service.lastHeartbeatAt).isAfter(cutoff),
    );
  }
}

export { InMemoryDataAccessServiceRegistry };
