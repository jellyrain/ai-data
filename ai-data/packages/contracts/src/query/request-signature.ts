/**
 * 对已通过合同校验的 JSON 载荷递归排序对象键，使签名两端不受对象创建顺序影响。
 * 数组顺序属于查询语义，保持原顺序；调用方应传入可用 JSON 表达的值。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export { stableStringify };
