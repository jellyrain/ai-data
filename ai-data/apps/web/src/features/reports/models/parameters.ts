import { isDataValue, reportExecutionInputSchema } from "@ai-data/contracts";
import type { ReportDefinition, ReportParameter } from "@ai-data/contracts";
import type { ParameterDraft, ParameterDrafts, ParameterValues } from "./parameter-types";

/** 默认值只用于呈现；未主动修改时仍省略提交，让 API 解析相对日期与默认规则。 */
function parameterInputRaw(parameter: ReportParameter, draft: ParameterDraft): string {
  if (draft.mode === "value") return draft.raw;
  if (draft.mode === "null") return "";
  const value = parameter.default_value;
  return value === undefined || value === null
    ? ""
    : Array.isArray(value)
      ? value.join("\n")
      : String(value);
}
/** 用业务文案表达默认状态，保留空值和空字符串的区别。 */
function parameterDefaultLabel(parameter: ReportParameter): string {
  const relative = parameter.relative_time;
  if (relative) {
    const range = relative.range;
    const periods: Record<string, string> = {
      this_year: "本年",
      this_quarter: "本季度",
      this_month: "本月",
      last_year: "上年",
      last_month: "上月",
    };
    const label =
      range.type === "fixed"
        ? `${range.start} 至 ${range.end}`
        : `${periods[range.period] ?? range.period}${range.extent === "to_date" ? " · 截至当天" : ""}`;
    return (
      label +
      (relative.part === "start" ? " · 开始日期" : relative.part === "end" ? " · 结束日期" : "")
    );
  }
  const value = parameter.default_value;
  const label = (item: unknown) =>
    item === null
      ? "空值"
      : item === ""
        ? "空字符串"
        : item === true
          ? "是"
          : item === false
            ? "否"
            : String(item);
  return value === undefined
    ? "未设置"
    : Array.isArray(value)
      ? value.map(label).join("、")
      : label(value);
}
/** 绑定决定参数形态，参数化数据集可通过数组默认值声明多值。 */
function parameterShape(
  definition: ReportDefinition,
  parameter: ReportParameter,
): "scalar" | "multiple" | "range" {
  const targets = definition.queries
    .flatMap((query) => query.bindings)
    .filter((binding) => binding.parameter === parameter.name)
    .map((binding) => binding.target);
  if (
    parameter.relative_time?.part === "range" ||
    targets.some((target) => target.type === "filter" && target.op === "between")
  )
    return "range";
  if (
    Array.isArray(parameter.default_value) ||
    targets.some((target) => target.type === "filter" && ["in", "not_in"].includes(target.op))
  )
    return "multiple";
  return "scalar";
}
function parameterDrafts(definition: ReportDefinition): ParameterDrafts {
  return Object.fromEntries(
    definition.parameters.map((parameter) => [parameter.name, { mode: "default", raw: "" }]),
  );
}
function scalar(raw: string, parameter: ReportParameter) {
  if (parameter.data_type === "boolean")
    return raw === "true" ? true : raw === "false" ? false : undefined;
  if (["integer", "decimal"].includes(parameter.data_type))
    return raw.trim() ? Number(raw) : undefined;
  return raw;
}
/** 只发送用户覆盖的条件；类型与上下界沿用公共合同的语义。 */
function readParameters(definition: ReportDefinition, drafts: ParameterDrafts): ParameterValues {
  const result: ParameterValues = {};
  for (const parameter of definition.parameters) {
    const draft = drafts[parameter.name];
    const fail = () => {
      throw new Error(`${parameter.label}：请填写符合类型、允许值和范围的条件`);
    };
    if (!draft || draft.mode === "default") {
      if (parameter.required && parameter.default_value === undefined && !parameter.relative_time)
        fail();
      continue;
    }
    const shape = parameterShape(definition, parameter);
    const value =
      draft.mode === "null"
        ? null
        : shape === "scalar"
          ? scalar(draft.raw, parameter)
          : draft.raw.split(/\r?\n/).map((raw) => scalar(raw, parameter));
    if (shape === "range" && (!Array.isArray(value) || value.length !== 2 || value[0]! > value[1]!))
      fail();
    if (shape === "multiple" && !Array.isArray(value)) fail();
    for (const item of Array.isArray(value) ? value : [value]) {
      if (
        !isDataValue(item, parameter.data_type) ||
        (item === null && parameter.required) ||
        (parameter.allowed_values && !parameter.allowed_values.includes(item as never)) ||
        (item !== null &&
          parameter.min !== undefined &&
          (typeof item !== typeof parameter.min || item! < parameter.min)) ||
        (item !== null &&
          parameter.max !== undefined &&
          (typeof item !== typeof parameter.max || item! > parameter.max))
      )
        fail();
    }
    const parsed = reportExecutionInputSchema.shape.parameters.safeParse({
      [parameter.name]: value,
    });
    if (!parsed.success) fail();
    Object.assign(result, parsed.data);
  }
  return result;
}
export {
  parameterShape,
  parameterDrafts,
  readParameters,
  parameterInputRaw,
  parameterDefaultLabel,
};
