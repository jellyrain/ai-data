import dayjs from "dayjs";
import pLimit from "p-limit";

import type { DataSourceConfig } from "../metadata/metadata-records";
import type { ConnectorKind, DataSourceConnector } from "./connector";
import type { DiscoveredDataset } from "./connector-catalog";
import { connectorExecutionResultSchema, type ConnectorExecutionResult } from "./connector-result";
import type { DatabaseDialect } from "./dialects/database-dialect";
import type { ExecutableQuery } from "./executable-query";
import { compileSqlQuery } from "./sql-query-compiler";
import type { ParameterDataType } from "./dialects/database-dialect";

/** 数据库驱动返回的一行记录。 */
type DatabaseRow = Record<string, unknown>;

/** 数据库驱动执行参数及 API 已确认的类型语义。 */
type DatabaseParameter = {
  value: string | number | boolean | null | Buffer;
  dataType: ParameterDataType;
};

/** 四类数据库驱动适配到的最小执行能力。 */
interface DatabaseDriver {
  /** 执行只读 SQL 或目录查询。 */
  query(sql: string, parameters: DatabaseParameter[]): Promise<DatabaseQueryResult>;
  /** 关闭该数据源独立连接池。 */
  close(): Promise<void>;
}

/** 数据库查询的统一记录和列元数据。 */
interface DatabaseQueryResult {
  /** 返回行。 */
  rows: DatabaseRow[];
  /** 可选驱动列元数据；缺失时由第一行值推断。 */
  columns?: DatabaseColumn[];
}

/** 数据库目录或查询结果的一列。 */
interface DatabaseColumn {
  /** 列名。 */
  name: string;
  /** 数据库原生类型名称。 */
  dataType?: string;
  /** 是否允许空值。 */
  nullable?: boolean;
  /** 源字段说明。 */
  description?: string;
}

/** 使用统一执行规划将数据库方言和连接池封装为 DAS 连接器。 */
class DatabaseConnector implements DataSourceConnector {
  readonly sourceId: string;
  readonly kind: Exclude<ConnectorKind, "http_api">;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(
    config: DataSourceConfig,
    private readonly driver: DatabaseDriver,
    private readonly dialect: DatabaseDialect,
  ) {
    this.sourceId = config.sourceId;
    this.kind = dialect.kind;
    this.limit = pLimit(config.concurrencyLimit);
  }

  /** 使用最小只读语句检查业务数据源连接池。 */
  async checkHealth() {
    try {
      await this.driver.query(this.dialect.healthSql(), []);
      return {
        source_id: this.sourceId,
        status: "healthy" as const,
        checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      };
    } catch (error) {
      return {
        source_id: this.sourceId,
        status: "unhealthy" as const,
        checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        message: error instanceof Error ? error.message : "数据源健康检查失败",
      };
    }
  }

  /** 从业务数据库系统目录构造统一目录，不返回连接凭据。 */
  async discoverCatalog(): Promise<DiscoveredDataset[]> {
    const result = await this.driver.query(this.dialect.catalogSql(), []);
    return groupCatalogRows(result.rows);
  }

  /** 编译最终 DSL，执行参数化 SQL，并转换为标准化表格结果。 */
  async execute(query: ExecutableQuery): Promise<ConnectorExecutionResult> {
    if (query.source_id !== this.sourceId) {
      throw new Error(`查询数据源与连接器不匹配: ${query.source_id}`);
    }
    const compiled = compileSqlQuery(query, this.dialect);
    const result = await this.limit(() => this.driver.query(compiled.sql, compiled.parameters));
    const sourceRows = result.rows.slice(0, query.row_limit);
    const columns =
      result.columns?.map((column) => ({
        name: column.name,
        data_type: normalizeDataType(column.dataType),
      })) ?? inferColumns(sourceRows);
    const rows = sourceRows.map(normalizeRowBuffers);
    return connectorExecutionResultSchema.parse({
      columns,
      rows,
      row_count: rows.length,
      truncated: result.rows.length > rows.length,
    });
  }

  /** 释放该数据源独立连接池。 */
  async close(): Promise<void> {
    this.limit.clearQueue();
    await this.driver.close();
  }
}

/** 将目录查询的扁平列记录按对象聚合为统一数据集。 */
function groupCatalogRows(rows: DatabaseRow[]): DiscoveredDataset[] {
  const datasets = new Map<string, DiscoveredDataset>();
  for (const row of rows) {
    const schema = asString(row.schema_name) ?? "";
    const name = asString(row.object_name) ?? asString(row.table_name);
    if (name === undefined) continue;
    const kind = normalizeObjectKind(asString(row.object_kind));
    const key = `${schema}.${name}.${kind}`;
    const current = datasets.get(key) ?? {
      kind,
      ...(schema === "" ? {} : { native_schema_name: schema }),
      native_object_name: name,
      ...(asString(row.object_description)
        ? { source_description: asString(row.object_description) }
        : {}),
      columns: [],
    };
    const columnName = asString(row.column_name);
    if (columnName !== undefined && !current.columns.some((column) => column.name === columnName)) {
      current.columns.push({
        name: columnName,
        data_type: normalizeDataType(asString(row.data_type)),
        nullable: normalizeNullable(row.is_nullable),
        ...(asString(row.column_description)
          ? { source_description: asString(row.column_description) }
          : {}),
      });
    }
    datasets.set(key, current);
  }
  return [...datasets.values()];
}

/** 将数据库目录类型映射到统一对象类型。 */
function normalizeObjectKind(kind: string | undefined): DiscoveredDataset["kind"] {
  if (kind === "view" || kind === "stored_procedure" || kind === "api_dataset") return kind;
  return "table";
}

/** 将数据库原生列类型映射到合同标准类型。 */
function normalizeDataType(
  type: string | undefined,
): "string" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "buffer" {
  const value = (type ?? "").toLowerCase();
  if (["int", "integer", "smallint", "tinyint", "bigint", "serial"].includes(value))
    return "integer";
  if (["decimal", "numeric", "money", "float", "real", "double", "number"].includes(value))
    return "decimal";
  if (["bit", "boolean", "bool"].includes(value)) return "boolean";
  if (["date"].includes(value)) return "date";
  if (value.includes("time")) return "datetime";
  if (["binary", "varbinary", "blob", "raw", "bytea", "image"].some((name) => value.includes(name)))
    return "buffer";
  return "string";
}

/** 将驱动的可空标记统一为布尔值。 */
function normalizeNullable(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    String(value).toUpperCase() === "YES" ||
    String(value).toUpperCase() === "Y"
  );
}

/** 驱动未返回列元数据时，按首行值生成最小统一列定义。 */
function inferColumns(
  rows: DatabaseRow[],
): Array<{ name: string; data_type: ReturnType<typeof inferDataType> }> {
  const firstRow = rows[0];
  if (firstRow === undefined) return [];
  return Object.entries(firstRow).map(([name, value]) => ({
    name,
    data_type: inferDataType(value),
  }));
}

function inferDataType(
  value: unknown,
): "string" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "buffer" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  if (value instanceof Date) return "datetime";
  if (Buffer.isBuffer(value)) return "buffer";
  if (typeof value === "string") return "string";
  return "string";
}

/** 结果通过 JSON 返回前，将二进制列转换为 Base64 文本。 */
function normalizeRowBuffers(row: DatabaseRow): DatabaseRow {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      Buffer.isBuffer(value) ? value.toString("base64") : value,
    ]),
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export { DatabaseConnector };
export type { DatabaseColumn, DatabaseDriver, DatabaseParameter, DatabaseQueryResult };
export type { DatabaseDialect } from "./dialects/database-dialect";
