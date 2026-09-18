import { queryDslSchema, type QueryResult } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";

/** 分析证据保留原有五千行容量，完整明细通过独立的 /query 响应交付。 */
function parseAnalysisQuery(input: unknown) {
  const query = queryDslSchema.parse(input);
  if ((query.limit ?? 5000) > 5000)
    throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "分析查询超出证据容量，请缩小范围");
  return queryDslSchema.parse({ ...query, limit: query.limit ?? 5000 });
}

/** 证据的持久化容量与明细交付容量分别控制，拒绝超量响应进入运行事务。 */
function assertAnalysisResultBudget(result: QueryResult): void {
  if (
    result.row_count > 5000 ||
    Buffer.byteLength(JSON.stringify(result), "utf8") > 2 * 1024 * 1024
  )
    throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "分析结果超出证据容量，请缩小范围");
}

/** SSE 提供最多一百行、256 KiB 的展示样本，完整证据由受权限保护的读取接口提供。 */
function sampleAnalysisRows(result: QueryResult): QueryResult["rows"] {
  let bytes = Buffer.byteLength(JSON.stringify({ columns: result.columns, rows: [] }), "utf8");
  if (bytes > 256 * 1024)
    throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "分析结果列信息超出展示容量");
  const rows: QueryResult["rows"] = [];
  for (const row of result.rows.slice(0, 100)) {
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + (rows.length > 0 ? 1 : 0);
    if (bytes > 256 * 1024) break;
    rows.push(row);
  }
  return rows;
}

export { parseAnalysisQuery, assertAnalysisResultBudget, sampleAnalysisRows };
