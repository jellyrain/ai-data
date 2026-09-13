import dayjs from "dayjs";

import type { DataSourceConfig } from "../data-sources/data-source-types";
import type { ConnectorKind, DataSourceConnector } from "./connector";
import type { DiscoveredDataset } from "./connector-catalog";
import { connectorExecutionResultSchema, type ConnectorExecutionResult } from "./connector-result";
import type { DatabaseDialect } from "./dialects/database-dialect";
import type { ExecutableQuery } from "./executable-query";
import { compileSqlQuery } from "./sql-query-compiler";
import { normalizeResultValue } from "./result-value";
import type { ResultDateMode } from "./result-value-types";
import type { ParameterDataType } from "./dialects/database-dialect";
import type {
  ActiveQueryOptions,
  ConnectorExecutionOptions,
  QueryExecutionOptions,
} from "./query-execution-types";
import { QueryResourceGate } from "./query-resource-gate";

/** 数据库驱动返回的一行记录。 */
type DatabaseRow = Record<string, unknown>;

/** 数据库驱动执行参数及 API 已确认的类型语义。 */
type DatabaseParameter = {
  /** 驱动可绑定的基础值；二进制已从传输文本还原。 */
  value: string | number | boolean | null | Buffer;
  /** 绑定时使用的合同数据类型。 */
  dataType: ParameterDataType;
};

/** 四类数据库驱动适配到的最小执行能力。 */
interface DatabaseDriver {
  /** 执行编译器或目录模板提供的 SQL；只读权限由业务数据库账号和调用对象约束。 */
  query(
    sql: string,
    parameters: DatabaseParameter[],
    options?: QueryExecutionOptions,
  ): Promise<DatabaseQueryResult>;
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
  /** 无时区数据库日期的驱动 Date 编码；省略时按时间点处理。 */
  dateMode?: ResultDateMode;
  /** 是否允许空值。 */
  nullable?: boolean;
  /** 源字段说明。 */
  description?: string;
}

/** 使用统一执行规划将数据库方言和连接池封装为 DAS 连接器。 */
class DatabaseConnector implements DataSourceConnector {
  readonly sourceId: string;
  readonly kind: Exclude<ConnectorKind, "http_api">;
  private readonly resources: QueryResourceGate;

  constructor(
    config: DataSourceConfig,
    private readonly driver: DatabaseDriver,
    private readonly dialect: DatabaseDialect,
  ) {
    this.sourceId = config.sourceId;
    this.kind = dialect.kind;
    this.resources = new QueryResourceGate(config);
  }

  /** 使用最小只读语句检查业务数据源连接池。 */
  async checkHealth() {
    try {
      await this.resources.run((options) =>
        this.driver.query(this.dialect.healthSql(), [], options),
      );
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
    const result = await this.resources.run((options) =>
      this.driver.query(this.dialect.catalogSql(), [], options),
    );
    return groupCatalogRows(result.rows, this.kind);
  }

  /** 编译最终 DSL，执行参数化 SQL，并转换为标准化表格结果。 */
  execute(
    query: ExecutableQuery,
    options: ConnectorExecutionOptions = {},
  ): Promise<ConnectorExecutionResult> {
    return this.resources.run((active) => this.executeQuery(query, active), {
      ...options,
      timeoutMs: query.timeout_ms,
    });
  }

  private async executeQuery(
    query: ExecutableQuery,
    options: ActiveQueryOptions,
  ): Promise<ConnectorExecutionResult> {
    if (query.source_id !== this.sourceId) {
      throw new Error(`查询数据源与连接器不匹配: ${query.source_id}`);
    }
    if (
      query.type === "parameterized_query" &&
      (!query.fixed_output?.length || this.kind === "oracle")
    ) {
      throw new Error("存储过程缺少可执行的固定输出定义或原生调用支持");
    }
    const compiled = compileSqlQuery(query, this.dialect);
    const result = await this.driver.query(compiled.sql, compiled.parameters, options);
    if (query.type === "parameterized_query") {
      const expected = query.fixed_output!;
      const actual = result.columns;
      if (
        !actual ||
        actual.length !== expected.length ||
        new Set(actual.map((column) => column.name)).size !== actual.length ||
        expected.some((column) => {
          const returned = actual.find((item) => item.name === column.name);
          return (
            !returned ||
            !returned.dataType ||
            normalizeDataType(returned.dataType, this.kind) !== column.data_type ||
            (returned.nullable !== undefined && returned.nullable !== column.nullable)
          );
        })
      )
        throw new Error("存储过程固定输出列定义已变化");
      // 校验全部实际返回记录，使越过截断边界的结构变化也不能被接受。
      for (const row of result.rows) {
        if (
          Object.keys(row).length !== expected.length ||
          expected.some((column) => !Object.hasOwn(row, column.name))
        ) {
          throw new Error("存储过程固定输出列集合已变化");
        }
        for (const column of expected) {
          if ((row[column.name] === null || row[column.name] === undefined) && !column.nullable) {
            throw new Error(`存储过程固定输出字段不允许空值: ${column.name}`);
          }
          normalizeResultValue(
            row[column.name],
            column.data_type,
            column.name,
            actual.find((item) => item.name === column.name)?.dateMode,
          );
        }
      }
    }
    // 关系查询包含一行额外探测结果；固定对象调用按实际返回记录判断，出口统一裁剪至 row_limit。
    const sourceRows = result.rows.slice(0, query.row_limit);
    const columns =
      result.columns?.map((column) => ({
        name: column.name,
        data_type: normalizeDataType(column.dataType, this.kind),
      })) ?? inferColumns(sourceRows);
    const rows = sourceRows.map((row) => {
      if (
        Object.keys(row).length !== columns.length ||
        Object.keys(row).some((name) => !columns.some((column) => column.name === name))
      )
        throw new Error("结果行字段必须与列定义一致");
      return Object.fromEntries(
        columns.map((column, index) => {
          if (!Object.hasOwn(row, column.name)) throw new Error(`结果字段 ${column.name} 缺失`);
          return [
            column.name,
            normalizeResultValue(
              row[column.name],
              column.data_type,
              column.name,
              result.columns?.[index]?.dateMode,
            ),
          ];
        }),
      );
    });
    return connectorExecutionResultSchema.parse({
      columns,
      rows,
      row_count: rows.length,
      truncated: result.rows.length > rows.length,
    });
  }

  /** 释放该数据源独立连接池。 */
  async close(): Promise<void> {
    await this.resources.close();
    await this.driver.close();
  }
}

/** 将目录查询的扁平列记录按对象聚合为统一数据集。 */
function groupCatalogRows(
  rows: DatabaseRow[],
  sourceKind: DatabaseConnector["kind"],
): DiscoveredDataset[] {
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
        data_type: normalizeDataType(asString(row.data_type), sourceKind),
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

/** 按已识别的数据库类型映射合同类型；缺失或未知类型统一回退为 string。 */
function normalizeDataType(
  type: string | undefined,
  kind: DatabaseConnector["kind"],
): "string" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "buffer" {
  const value = (type ?? "").toLowerCase();
  // MySQL 目录投影 BIT 位宽，与驱动结果 BIT(1) 布尔、BIT(n) 二进制的映射一致。
  if (kind === "mysql" && /^bit\(\d+\)$/.test(value))
    return value === "bit(1)" ? "boolean" : "buffer";
  if (kind === "sqlserver" && ["timestamp", "rowversion"].includes(value)) return "buffer";
  if (kind === "oracle" && value === "date") return "datetime";
  if (kind === "postgresql" && ["bit", "bit varying", "varbit"].includes(value)) return "string";
  // PostgreSQL money 的文本格式由源数据库区域设置决定，目录与结果统一保留原始文本。
  if (kind === "postgresql" && value === "money") return "string";
  if (
    [
      "int",
      "integer",
      "smallint",
      "tinyint",
      "bigint",
      "serial",
      "mediumint",
      "year",
      "int2",
      "int4",
      "int8",
      "smallserial",
      "bigserial",
    ].includes(value)
  )
    return "integer";
  if (
    [
      "decimal",
      "numeric",
      "money",
      "smallmoney",
      "float",
      "real",
      "double",
      "double precision",
      "number",
      "binary_float",
      "binary_double",
    ].includes(value)
  )
    return "decimal";
  if (["bit", "boolean", "bool"].includes(value)) return "boolean";
  if (["date"].includes(value)) return "date";
  if (value === "time" || value === "timetz" || value.startsWith("time ")) return "string";
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

/** 无列元数据时按首行 JavaScript 值推断类型；null 等未知值回退为 string。 */
function inferDataType(
  value: unknown,
): "string" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "buffer" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  if (value instanceof Date) return "datetime";
  if (Buffer.isBuffer(value)) return "buffer";
  if (typeof value === "string") return "string";
  return "string";
}

/** 目录中的空文本与非文本值按缺失处理，供名称和说明映射复用。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export { DatabaseConnector };
export type { DatabaseColumn, DatabaseDriver, DatabaseParameter, DatabaseQueryResult };
export type { DatabaseDialect } from "./dialects/database-dialect";
