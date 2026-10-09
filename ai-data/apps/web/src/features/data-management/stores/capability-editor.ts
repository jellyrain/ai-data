import {
  queryCapabilitiesSchema,
  queryOperatorSchema,
  queryParameterPolicySchema,
  queryPermissionBindingSchema,
  isDataValue,
  type Dataset,
  type DatasetColumn,
  type QueryCapabilities,
} from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";

/** 四组能力独立保留省略、空数组和显式字段集合的语义。 */
type CapabilityKey = keyof QueryCapabilities;
/** 可视化控件的三种配置方式，自定义空集合保存后等同禁用。 */
type CapabilityMode = "default" | "custom" | "disabled";
/** 聚合函数来自共享合同，与后端类型限制保持一致。 */
type AggregateFunction = NonNullable<
  QueryCapabilities["aggregations"]
>[number]["functions"][number];
const capabilityLabels: Record<CapabilityKey, string> = {
  sortable_fields: "排序",
  groupable_fields: "分组",
  filter_conditions: "筛选",
  aggregations: "统计",
};
const operatorLabels: Record<string, string> = {
  eq: "等于",
  neq: "不等于",
  in: "属于",
  not_in: "不属于",
  between: "范围",
  is_null: "为空",
  not_null: "不为空",
};
const aggregateLabels: Record<AggregateFunction, string> = {
  count: "计数",
  count_distinct: "去重计数",
  sum: "求和",
  avg: "平均",
  min: "最小值",
  max: "最大值",
};
const dataTypeLabels: Record<DatasetColumn["data_type"], string> = {
  string: "文本",
  integer: "整数",
  decimal: "数值",
  boolean: "布尔",
  date: "日期",
  datetime: "日期时间",
  buffer: "二进制",
};

function capabilityMode(value: QueryCapabilities | undefined, key: CapabilityKey): CapabilityMode {
  return value?.[key] === undefined ? "default" : value[key]!.length ? "custom" : "disabled";
}
function changeCapabilityMode(
  value: QueryCapabilities | undefined,
  key: CapabilityKey,
  mode: CapabilityMode,
): QueryCapabilities | undefined {
  const next = { ...value };
  if (mode === "default") delete next[key];
  else next[key] = [];
  return Object.keys(next).length ? next : undefined;
}
function capabilityNames(value: QueryCapabilities | undefined, key: CapabilityKey): string[] {
  if (key === "filter_conditions") return value?.filter_conditions?.map((c) => c.name) ?? [];
  if (key === "aggregations") return value?.aggregations?.map((c) => c.field) ?? [];
  return value?.[key] ?? [];
}
/** base 有显式集合时仅提供源已允许字段；省略表示表/视图的默认范围。 */
function capabilityFields(
  columns: DatasetColumn[],
  key: CapabilityKey,
  base?: QueryCapabilities,
): DatasetColumn[] {
  return base?.[key] === undefined
    ? columns
    : columns.filter((c) => capabilityNames(base, key).includes(c.name));
}
function aggregateFunctions(column: DatasetColumn, base?: QueryCapabilities): AggregateFunction[] {
  const functions: AggregateFunction[] = ["count", "count_distinct"];
  if (["integer", "decimal"].includes(column.data_type)) functions.push("sum", "avg");
  if (!["buffer", "boolean"].includes(column.data_type)) functions.push("min", "max");
  return base?.aggregations === undefined
    ? functions
    : functions.filter((f) =>
        base.aggregations!.some((c) => c.field === column.name && c.functions.includes(f)),
      );
}
function filterOperators(column: DatasetColumn, base?: QueryCapabilities) {
  return base?.filter_conditions === undefined
    ? [...queryOperatorSchema.options]
    : (base.filter_conditions.find((c) => c.name === column.name)?.allowed_ops ?? []);
}
/** 已选字段的高级属性完整保留，新字段从源定义或标准能力生成。 */
function selectCapabilityFields(
  value: QueryCapabilities | undefined,
  key: CapabilityKey,
  names: string[],
  columns: DatasetColumn[],
  base?: QueryCapabilities,
): QueryCapabilities {
  const next = { ...value };
  const column = (name: string) => columns.find((c) => c.name === name);
  if (key === "filter_conditions")
    next.filter_conditions = names.map((name) => {
      const old =
        value?.filter_conditions?.find((c) => c.name === name) ??
        base?.filter_conditions?.find((c) => c.name === name);
      if (old) return { ...old, allowed_ops: [...old.allowed_ops] };
      const found = column(name);
      if (!found) reject(`筛选字段不存在：${name}`);
      return {
        name,
        data_type: found.data_type,
        allowed_ops: filterOperators(found, base),
        required: false,
      };
    });
  else if (key === "aggregations")
    next.aggregations = names.map((field) => {
      const old = value?.aggregations?.find((c) => c.field === field);
      if (old) return { ...old, functions: [...old.functions] };
      const found = column(field);
      if (!found) reject(`统计字段不存在：${field}`);
      return { field, functions: aggregateFunctions(found, base) };
    });
  else next[key] = [...names];
  return next;
}
function reject(message: string): never {
  throw new ApiError(message, 400, "INVALID_INPUT");
}

/** 可视化表单按真实字段及源上限检查，服务端仍是最终授权边界。 */
function validateCapabilities(
  value: QueryCapabilities | undefined,
  columns: DatasetColumn[],
  base?: QueryCapabilities,
): void {
  if (value === undefined) return;
  if (!queryCapabilitiesSchema.safeParse(value).success)
    reject("请检查查询能力：每个字段至少选择一种操作，默认值须符合字段类型。");
  for (const key of Object.keys(capabilityLabels) as CapabilityKey[]) {
    const names = capabilityNames(value, key);
    if (new Set(names).size !== names.length) reject(`${capabilityLabels[key]}字段不能重复`);
    for (const name of names) {
      if (!columns.some((c) => c.name === name)) reject(`字段已不存在：${name}，请重新选择或移除`);
      if (!capabilityFields(columns, key, base).some((c) => c.name === name))
        reject(`${name} 超出源能力允许的${capabilityLabels[key]}范围`);
    }
  }
  for (const entry of value.filter_conditions ?? []) {
    const column = columns.find((c) => c.name === entry.name)!;
    if (column.data_type !== entry.data_type) reject(`${entry.name} 的字段类型已变化，请重新选择`);
    if (entry.allowed_ops.some((op) => !filterOperators(column, base).includes(op)))
      reject(`${entry.name} 的筛选操作超出源能力`);
    if (base?.filter_conditions?.find((c) => c.name === entry.name)?.required && !entry.required)
      reject(`${entry.name} 不能取消源要求的必填约束`);
  }
  for (const entry of value.aggregations ?? []) {
    if (
      entry.functions.some(
        (fn) =>
          !aggregateFunctions(
            columns.find((c) => c.name === entry.field)!,
            base,
          ).includes(fn),
      )
    )
      reject(`${entry.field} 的统计函数与类型或源能力不匹配`);
  }
}
/** 参数策略只收紧源约束；权限绑定必须是类型匹配且支持等值的单一字段与参数。 */
function validateParameterSettings(
  dataset: Dataset,
  policiesInput: unknown,
  bindingsInput: unknown,
): void {
  const policyResult = queryParameterPolicySchema.array().optional().safeParse(policiesInput);
  const bindingResult = queryPermissionBindingSchema.array().optional().safeParse(bindingsInput);
  if (!policyResult.success) reject("请检查参数策略：每个自定义参数至少选择一种允许操作。");
  if (!bindingResult.success) reject("请为每条权限绑定选择输出字段和输入参数。");
  const policies = policyResult.data ?? [];
  const bindings = bindingResult.data ?? [];
  const definitions = new Map(dataset.query_parameters.map((p) => [p.name, { ...p }]));
  if (new Set(policies.map((p) => p.name)).size !== policies.length) reject("参数策略不能重复");
  for (const policy of policies) {
    const def = definitions.get(policy.name);
    if (!def) reject(`参数已不存在：${policy.name}`);
    if (def.required && policy.required === false)
      reject(`${policy.name} 不能取消源要求的必填约束`);
    if (policy.allowed_ops?.some((op) => !def.allowed_ops.includes(op)))
      reject(`${policy.name} 不能扩大允许操作`);
    if (policy.default_value !== undefined && !isDataValue(policy.default_value, def.data_type))
      reject(`${policy.name} 的默认值与参数类型不一致`);
    definitions.set(policy.name, { ...def, allowed_ops: policy.allowed_ops ?? def.allowed_ops });
  }
  if (bindings.length && !["stored_procedure", "api_dataset"].includes(dataset.kind))
    reject("权限参数绑定只适用于参数化数据集");
  for (const key of ["field", "parameter"] as const)
    if (new Set(bindings.map((b) => b[key])).size !== bindings.length)
      reject("权限绑定的字段和参数不能重复");
  for (const binding of bindings) {
    const column = dataset.columns.find((c) => c.name === binding.field),
      parameter = definitions.get(binding.parameter);
    if (
      !column ||
      !parameter ||
      column.data_type !== parameter.data_type ||
      !parameter.allowed_ops.includes("eq")
    )
      reject("权限绑定需要存在且类型相同的输出字段与等值输入参数");
  }
}
export {
  capabilityMode,
  changeCapabilityMode,
  capabilityNames,
  capabilityFields,
  aggregateFunctions,
  filterOperators,
  selectCapabilityFields,
  validateCapabilities,
  validateParameterSettings,
  capabilityLabels,
  operatorLabels,
  aggregateLabels,
  dataTypeLabels,
};
export type { CapabilityKey, CapabilityMode, AggregateFunction };
