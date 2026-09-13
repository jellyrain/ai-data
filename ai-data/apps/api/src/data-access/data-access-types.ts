import type { DataAccessHeartbeat, Dataset, SourceHealth } from "@ai-data/contracts";

/** API 接收心跳后保存的 DAS 实例和数据源状态快照。 */
type DataAccessServiceRegistration = {
  /** DAS 实例标识。 */
  serviceId: string;
  /** API 调用该实例时使用的地址。 */
  serviceUrl: string;
  /** DAS 发布版本。 */
  serviceVersion: string | null;
  /** 最近一次心跳报告的服务状态。 */
  status: "healthy" | "unhealthy";
  /** 最近一次心跳到达 API 的时间。 */
  lastHeartbeatAt: Date;
  /** DAS 发送的补充状态说明。 */
  message: string | null;
  /** 最近一次报告的数据源健康快照。 */
  sources: SourceHealth[];
};

/** API 心跳路由和 DAS 客户端所需的实例注册与发现能力。 */
interface DataAccessServiceRegistry {
  /** 以最新心跳和 API 从连接地址推导的服务地址替换一个 DAS 实例及其数据源状态。 */
  registerHeartbeat(
    heartbeat: DataAccessHeartbeat,
    serviceUrl: string,
  ): Promise<DataAccessServiceRegistration>;
  /** 返回当前仍在有效心跳窗口内的健康 DAS 实例。 */
  listHealthyServices(): Promise<DataAccessServiceRegistration[]>;
}

/** API 获取 DAS 物理目录所需的最小客户端能力。 */
interface DataAccessCatalogClient {
  /** 从指定 DAS 实例读取一个数据源的标准化目录。 */
  listCatalog(serviceUrl: string, sourceId: string, serviceId: string): Promise<Dataset[]>;
}

export type { DataAccessCatalogClient, DataAccessServiceRegistration, DataAccessServiceRegistry };
