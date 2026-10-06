import type { ManageableSourceObject, QueryCapabilities } from "@ai-data/contracts";

/** 管理能力只引用实际字段，并保留连接器已声明的限制。 */
function managedObjectCapabilities(
  object: ManageableSourceObject,
  requested: QueryCapabilities,
): QueryCapabilities {
  const base = object.query_capabilities ?? {};
  const result = { ...base, ...requested };
  const columns = new Map(object.columns.map((column) => [column.name, column]));
  if (object.kind !== "table" && object.kind !== "view") {
    if (Object.values(result).some((values) => values.length > 0))
      throw new Error("固定参数对象不支持关系操作能力");
    return result;
  }
  for (const key of ["sortable_fields", "groupable_fields"] as const) {
    if (
      result[key]?.some(
        (field) => !columns.has(field) || (base[key] !== undefined && !base[key]!.includes(field)),
      )
    )
      throw new Error("字段能力超出实际目录范围");
  }
  if (
    base.filter_conditions?.some(
      (condition) =>
        condition.required &&
        !result.filter_conditions?.some((item) => item.name === condition.name && item.required),
    )
  )
    throw new Error("缺少必填过滤条件");
  for (const condition of result.filter_conditions ?? []) {
    const inherited = base.filter_conditions?.find((item) => item.name === condition.name);
    if (
      columns.get(condition.name)?.data_type !== condition.data_type ||
      (base.filter_conditions !== undefined &&
        (!inherited ||
          condition.allowed_ops.some((op) => !inherited.allowed_ops.includes(op)) ||
          (inherited.required && !condition.required)))
    )
      throw new Error("过滤能力超出实际目录范围");
  }
  for (const aggregation of result.aggregations ?? []) {
    const inherited = base.aggregations?.find((item) => item.field === aggregation.field);
    if (
      !columns.has(aggregation.field) ||
      (base.aggregations !== undefined &&
        (!inherited || aggregation.functions.some((fn) => !inherited.functions.includes(fn))))
    )
      throw new Error("聚合能力超出实际目录范围");
  }
  return result;
}
export { managedObjectCapabilities };
