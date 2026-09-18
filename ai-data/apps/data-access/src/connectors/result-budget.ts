import { MAX_QUERY_ROWS, MAX_QUERY_TABLE_BYTES, type QueryResult } from "@ai-data/contracts";
import { QueryResourceError } from "./query-resource-error";

/** 标准化表格按 UTF-8 JSON 计量；容量失败在交付前归入资源拒绝。 */
function assertResultBudget(result: Pick<QueryResult, "columns" | "rows">): void {
  if (result.rows.length > MAX_QUERY_ROWS) throw new QueryResourceError("QUERY_LIMIT_EXCEEDED");
  let bytes = Buffer.byteLength(JSON.stringify({ columns: result.columns, rows: [] }), "utf8");
  if (bytes > MAX_QUERY_TABLE_BYTES) throw new QueryResourceError("QUERY_LIMIT_EXCEEDED");
  for (const [index, row] of result.rows.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + (index > 0 ? 1 : 0);
    if (bytes > MAX_QUERY_TABLE_BYTES) throw new QueryResourceError("QUERY_LIMIT_EXCEEDED");
  }
}

export { assertResultBudget };
