import type { SourceHealth } from "@ai-data/contracts";

import type { DiscoveredDataset } from "./connector-catalog";
import type { ConnectorExecutionResult } from "./connector-result";
import type { ExecutableQuery } from "./executable-query";
import type { ConnectorExecutionOptions } from "./query-execution-types";

/** DAS 当前支持纳入统一连接器框架的数据源类型。 */
type ConnectorKind = "sqlserver" | "mysql" | "postgresql" | "oracle" | "http_api";

/** 一个已按 source_id 初始化的数据源连接器必须提供的受控能力。 */
interface DataSourceConnector {
  /** 该实例绑定的数据源配置标识。 */
  readonly sourceId: string;
  /** 用于运行时诊断和连接器选择的数据源类型。 */
  readonly kind: ConnectorKind;

  /** 执行连接器定义的轻量探测并返回状态快照。 */
  checkHealth(): Promise<SourceHealth>;
  /** 发现数据库纯目录，或从 HTTP API 已审核虚拟表定义构造目录。 */
  discoverCatalog(): Promise<DiscoveredDataset[]>;
  /** 执行 DAS 规划器提供的内部 DSL，使用其中的物理映射和结果上限。 */
  execute(
    query: ExecutableQuery,
    options?: ConnectorExecutionOptions,
  ): Promise<ConnectorExecutionResult>;
  /** DAS 退出、数据源停用或配置变更时释放连接池和网络资源。 */
  close(): Promise<void>;
}

export type { ConnectorKind, DataSourceConnector };
