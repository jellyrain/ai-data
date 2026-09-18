import type mssql from "mssql";
import type { QueryExecutionOptions } from "./query-execution-types";
import { QueryResourceError } from "./query-resource-error";

/** SQL Server 逐行收集受限结果，固定输出过程也受保留容量约束；等待原生请求完成再归还连接。 */
async function readSqlServerResult(
  request: mssql.Request,
  sql: string,
  budget: NonNullable<QueryExecutionOptions["resultBudget"]>,
) {
  const rows: Record<string, unknown>[] = [];
  let columns: mssql.IColumnMetadata = {};
  let recordsets = 0;
  let bytes = 0;
  let failure: Error | undefined;
  request.stream = true;
  const reject = (error: Error) => {
    if (failure) return;
    failure = error;
    request.cancel();
  };
  const onRecordset = (value: mssql.IColumnMetadata) => {
    if (++recordsets > 1) reject(new Error("数据库查询返回多个结果集"));
    else columns = value;
  };
  const onRow = (row: Record<string, unknown>) => {
    if (failure || rows.length >= budget.maxRows) return;
    try {
      // 原始数值中的 bigint 仅用于预算计量；真正的值转换仍由连接器执行。
      bytes +=
        Buffer.byteLength(
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
          "utf8",
        ) + 1;
      if (bytes > budget.maxBytes) reject(new QueryResourceError("QUERY_LIMIT_EXCEEDED"));
      else rows.push(row);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("查询结果无法计量"));
    }
  };
  // mssql 的 stream 模式会消费回调错误并正常结束 Promise，错误事件必须单独保存。
  const onError = (error: Error) => {
    failure ??= error;
  };
  request.on("recordset", onRecordset);
  request.on("row", onRow);
  request.on("error", onError);
  try {
    await request.query(sql);
    if (failure) throw failure;
    return { rows, columns };
  } catch (error) {
    throw failure ?? error;
  } finally {
    request.removeListener("recordset", onRecordset);
    request.removeListener("row", onRow);
    request.removeListener("error", onError);
  }
}

export { readSqlServerResult };
