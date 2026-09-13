/** DAS 当前使用的 Oracle 驱动最小类型声明，随实际调用能力扩充。 */
declare module "oracledb" {
  /** 将结果行按列名返回为对象时使用的驱动常量。 */
  const OUT_FORMAT_OBJECT: number;
  /** 结果提取为文本或二进制基础值的驱动类型常量。 */
  const DB_TYPE_VARCHAR: object;
  const DB_TYPE_RAW: object;

  /** Oracle 结果字段的原生类型、数值精度与可空元数据。 */
  interface ColumnMetadata {
    name: string;
    dbTypeName?: string;
    scale?: number;
    nullable?: boolean;
  }

  /** 执行结果中当前适配器消费的记录与列名称。 */
  interface ExecuteResult {
    /** 有记录集时提供的结果行。 */
    rows?: Array<Record<string, unknown>>;
    /** 驱动可提供的列名，空结果时也可用于构造列定义。 */
    metaData?: ColumnMetadata[];
  }

  /** 从池中借出的 Oracle 连接，调用方在完成后归还。 */
  interface Connection {
    /** 单次数据库往返的最大耗时，单位毫秒。 */
    callTimeout: number;
    /** 请求原生驱动中断当前连接上的执行。 */
    breakExecution(): Promise<void>;
    /** 按占位符顺序绑定参数，并可选择对象行输出格式。 */
    execute(
      sql: string,
      parameters?: unknown[],
      options?: {
        outFormat?: number;
        fetchTypeHandler?: (field: ColumnMetadata) => { type: object } | undefined;
      },
    ): Promise<ExecuteResult>;
    /** 归还当前连接。 */
    close(): Promise<void>;
  }

  /** 为单一数据源复用连接的 Oracle 池。 */
  interface Pool {
    /** 借出一条连接供当前请求使用。 */
    getConnection(): Promise<Connection>;
    /** 关闭连接池，可指定已借出连接的排空等待秒数。 */
    close(drainTime?: number): Promise<void>;
  }

  /** 根据目标、凭据与资源配置创建连接池。 */
  function createPool(options: {
    /** 由数据源目标配置生成的 Oracle 连接地址。 */
    connectString: string;
    /** 数据库登录账号。 */
    user: string;
    /** 由共享凭据解密得到的登录密码。 */
    password: string;
    /** 此池最多创建的连接数。 */
    poolMax: number;
    /** 此池保留的最小连接数。 */
    poolMin: number;
    /** 空闲连接回收等待时间，单位秒。 */
    poolTimeout: number;
    /** 每条连接的语句缓存条目数。 */
    stmtCacheSize: number;
    /** 等待借用连接的容量，与数据源并发容量一致。 */
    queueMax?: number;
    /** 等待借用连接的最长时间，单位毫秒。 */
    queueTimeout?: number;
  }): Promise<Pool>;

  export {
    OUT_FORMAT_OBJECT,
    DB_TYPE_VARCHAR,
    DB_TYPE_RAW,
    ExecuteResult,
    Connection,
    Pool,
    createPool,
  };
}
