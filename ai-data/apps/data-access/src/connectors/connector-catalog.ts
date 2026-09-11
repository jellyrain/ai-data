import type {
  DatasetColumn,
  Freshness,
  QueryCapabilities,
  QueryParameter,
} from "@ai-data/contracts";

/** 连接器从数据源发现或从 HTTP API 虚拟表配置构造的对象类型。 */
type DiscoveredObjectKind = "table" | "view" | "stored_procedure" | "api_dataset";

/** 数据源连接器内部发现的一张统一数据集，尚未与 DAS 对象白名单合并。 */
interface DiscoveredDataset {
  /** 连接器可识别的真实对象类型。 */
  kind: DiscoveredObjectKind;
  /** 业务数据库 Schema；HTTP API 虚拟表通常省略。 */
  native_schema_name?: string;
  /** 数据库真实对象名或 HTTP API 虚拟表的配置名。 */
  native_object_name: string;
  /** 源数据库注释或管理员配置的接口说明。 */
  source_description?: string;
  /** 已标准化的数据列。 */
  columns: DatasetColumn[];
  /** 连接器可发现或虚拟表配置声明的基础查询能力。 */
  query_capabilities?: QueryCapabilities;
  /** 存储过程或 HTTP API 虚拟表的固定输入参数定义。 */
  query_parameters?: QueryParameter[];
  /** 连接器可获得的数据新鲜度。 */
  freshness?: Freshness;
}

export type { DiscoveredDataset, DiscoveredObjectKind };
