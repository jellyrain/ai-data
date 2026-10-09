import type { QueryResult } from "@ai-data/contracts";

/** 模型取得有界样本和完整性说明，完整分析结果保存在当前证据中。 */
function modelQueryResult(result: QueryResult) {
  const rows: QueryResult["rows"] = [];
  // 执行 SQL 供用户核对证据，模型继续使用业务 DSL 与结果样本。
  const output = { ...result, rows, sampled: true };
  delete output.execution_sql;
  let bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  for (const row of result.rows.slice(0, 100)) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + (rows.length ? 1 : 0);
    if (bytes + size > 32768) break;
    rows.push(row);
    bytes += size;
  }
  output.sampled = rows.length < result.row_count;
  return output;
}
export { modelQueryResult };
