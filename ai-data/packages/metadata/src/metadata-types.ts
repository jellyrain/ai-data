/** 元数据库连接池需要的通用连接配置。 */
interface MetadataConnectionConfig {
  /** 元数据库服务器主机名或 IP 地址。 */
  server: string;
  /** 元数据库服务器 TCP 端口。 */
  port: number;
  /** 当前应用元数据库名称。 */
  database: string;
  /** 当前应用元数据库专属登录名。 */
  user: string;
  /** 当前应用元数据库连接密码。 */
  password: string;
  /** 连接池和链路安全配置。 */
  options: {
    /** 是否要求数据库链路加密。 */
    encrypt: boolean;
    /** 是否信任受控环境中的自签名证书。 */
    trust_server_certificate: boolean;
    /** 建立连接的最长等待时间。 */
    connection_timeout_ms: number;
    /** 单条元数据 SQL 的最长执行时间。 */
    request_timeout_ms: number;
    /** 连接池容量和空闲回收配置。 */
    pool: {
      /** 连接池最大连接数。 */
      max: number;
      /** 连接池最小预热连接数。 */
      min: number;
      /** 空闲连接回收时间。 */
      idle_timeout_ms: number;
    };
  };
}

/** 元数据库参数化 SQL 所支持的基础值类型。 */
type MetadataParameterType = "string" | "integer" | "bigint" | "boolean" | "binary" | "date";

/** SQL 参数名称，不包含驱动绑定时使用的前缀。 */
interface MetadataParameterBase {
  name: string;
}

/** 一条必须通过参数绑定传入元数据库的值。 */
type MetadataParameter =
  | (MetadataParameterBase & { type: "string"; value: string | null })
  | (MetadataParameterBase & { type: "integer" | "bigint"; value: number | null })
  | (MetadataParameterBase & { type: "boolean"; value: boolean | null })
  | (MetadataParameterBase & { type: "binary"; value: Buffer | null })
  | (MetadataParameterBase & { type: "date"; value: Date | null });

/** 仓储交给元数据库执行的一条固定 SQL 语句及其参数。 */
interface MetadataStatement {
  /** 仅由仓储定义的固定 SQL 模板，调用方数据不得参与字符串拼接。 */
  sql: string;
  /** 每个动态值都必须作为单独参数传递。 */
  parameters: MetadataParameter[];
}

/** 一次元数据库查询的标准化结果。 */
interface MetadataQueryResult<T extends Record<string, unknown>> {
  /** SELECT 或 OUTPUT 返回的记录集。 */
  rows: T[];
  /** 数据库对各语句报告的影响行数。 */
  rowsAffected: number[];
}

/** 仓储依赖的最小元数据库查询能力，便于隔离具体数据库实现。 */
interface MetadataQueryExecutor {
  /** 执行固定、参数化的元数据库语句。 */
  execute<T extends Record<string, unknown>>(
    statement: MetadataStatement,
  ): Promise<MetadataQueryResult<T>>;
}

/** 健康检查路由依赖的最小元数据库能力。 */
interface MetadataDatabaseHealthChecker {
  /** 返回元数据库是否可以执行最小只读请求。 */
  checkHealth(): Promise<MetadataDatabaseStatus>;
}

/** 元数据库连接健康状态。 */
type MetadataDatabaseStatus = "healthy" | "unhealthy";

/** 元数据库迁移批处理执行器。 */
interface MetadataBatchExecutor {
  /** 执行一批由应用提供的 SQL 迁移文本。 */
  executeBatch(sql: string): Promise<void>;
}

/** 已加载的元数据库迁移文件。 */
interface MetadataMigration {
  /** 迁移文件名，用于版本排序和部署审阅。 */
  fileName: string;
  /** 迁移文件中的 SQL 文本。 */
  sql: string;
}

export type {
  MetadataBatchExecutor,
  MetadataConnectionConfig,
  MetadataDatabaseHealthChecker,
  MetadataDatabaseStatus,
  MetadataMigration,
  MetadataParameter,
  MetadataParameterType,
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
};
