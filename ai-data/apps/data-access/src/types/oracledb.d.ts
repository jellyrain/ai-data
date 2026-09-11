declare module "oracledb" {
  const OUT_FORMAT_OBJECT: number;

  interface ExecuteResult {
    rows?: Array<Record<string, unknown>>;
    metaData?: Array<{ name: string }>;
  }

  interface Connection {
    execute(
      sql: string,
      parameters?: unknown[],
      options?: { outFormat?: number },
    ): Promise<ExecuteResult>;
    close(): Promise<void>;
  }

  interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }

  function createPool(options: {
    connectString: string;
    user: string;
    password: string;
    poolMax: number;
    poolMin: number;
    poolTimeout: number;
    stmtCacheSize: number;
  }): Promise<Pool>;

  export { OUT_FORMAT_OBJECT, ExecuteResult, Connection, Pool, createPool };
}
