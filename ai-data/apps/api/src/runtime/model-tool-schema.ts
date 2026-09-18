/** 发布模型可生成的 JSON 值形状；大字符串长度及类型组合由 API 完整校验。 */
function modelToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    );
    const properties = result.properties as Record<string, unknown> | undefined;
    if (properties?.data_type && properties.value && Object.keys(properties.value).length === 0) {
      const scalars = [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
      ];
      properties.value = {
        anyOf: properties.op ? [...scalars, { type: "array", items: { anyOf: scalars } }] : scalars,
        description: properties.op
          ? "eq/neq 使用单值；in/not_in 使用非空数组；between 使用 [起始值,结束值]；is_null/not_null 省略 value。日期使用 YYYY-MM-DD，日期时间使用 YYYY-MM-DD HH:mm:ss。"
          : "传与 data_type 一致的单值。日期使用 YYYY-MM-DD，日期时间使用 YYYY-MM-DD HH:mm:ss，buffer 使用 Base64 字符串。",
      };
    }
    if (
      result.type === "string" &&
      typeof result.maxLength === "number" &&
      result.maxLength >= 2000
    ) {
      result.description = [result.description, `最多 ${result.maxLength} 个字符，由 API 校验。`]
        .filter(Boolean)
        .join(" ");
      delete result.maxLength;
    }
    return result;
  }
  return visit(schema) as Record<string, unknown>;
}

export { modelToolSchema };
