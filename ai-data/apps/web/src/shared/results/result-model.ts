import type { QueryResult } from "@ai-data/contracts";
/** 本地分页共享原行引用，每页最多 200 行；业务数据不在此重新查询。 */
function pageRows<T>(rows: T[], requested: number, size: number) {
  if (![50, 100, 200].includes(size)) throw new Error("不支持的每页行数");
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(pages, Math.max(1, Math.floor(requested) || 1));
  return { page, pages, rows: rows.slice((page - 1) * size, page * size) };
}
/** 数据值按原始含义展示，NULL 与空文本区分。 */
function formatCell(value: unknown): string {
  return value === null ? "NULL" : String(value ?? "");
}
/** 图表只接受结果列映射，分类重复或空值交由用户调整，不改变统计口径。 */
function createChartData(
  result: Pick<QueryResult, "columns" | "rows">,
  kind: "bar" | "line" | "pie",
  dimension: string,
  metric: string,
) {
  const numeric = result.columns.find((column) => column.name === metric);
  if (
    !result.columns.some((column) => column.name === dimension) ||
    !numeric ||
    !["integer", "number", "decimal"].includes(numeric.data_type)
  )
    throw new Error("请选择有效的维度和数值列");
  if (!result.rows.length) throw new Error("当前结果没有可绘制的数据");
  const labels: string[] = [];
  const values: number[] = [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    const value = row[metric];
    if (typeof value !== "number" || !Number.isFinite(value) || row[dimension] === null)
      throw new Error("所选列存在空值或非数值，请查看表格或选择其他列");
    const label = formatCell(row[dimension]);
    if (seen.has(label)) throw new Error("维度值重复，请选择唯一维度；需要汇总时可继续提问");
    if (kind === "pie" && value < 0) throw new Error("饼图不能展示负值，请使用柱图或折线图");
    seen.add(label);
    labels.push(label);
    values.push(value);
  }
  if (kind === "pie" && values.every((value) => value === 0))
    throw new Error("全部为零时无法计算饼图占比");
  return { labels, values };
}
export { pageRows, formatCell, createChartData };
