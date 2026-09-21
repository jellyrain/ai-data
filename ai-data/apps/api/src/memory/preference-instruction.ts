import type { UserPreferenceInput } from "@ai-data/contracts";

/** 只从当前用户原文识别直接设置句；无法确定时仍走普通冲突确认。 */
function isExplicitPreferenceRequest(text: string, input: UserPreferenceInput): boolean {
  const request = text.trim();
  if (
    !/^(请)?(以后|今后|默认|记住|将|把|设置|改成|改为|不要默认|停用默认)/.test(request) ||
    /[「」“”"`]|[？?]|(文档|他说|假设|例如|如果)/.test(request)
  )
    return false;
  if (!/(默认|记住|设置|改成|改为)/.test(request)) return false;
  const disabled = /(不要默认|停用默认|不再默认)/.test(request);
  if (disabled === input.auto_apply) return false;
  const value = input.value;
  if (value.type === "time_range" && value.range.type === "relative") {
    const labels = {
      this_year: /本年|今年/,
      this_quarter: /本季|本季度/,
      this_month: /本月|这个月/,
      last_year: /去年|上一年/,
      last_month: /上月|上个月/,
    };
    return labels[value.range.period].test(request);
  }
  if (value.type === "presentation") {
    const label = { table: /表格/, chart: /图表/, text: /文字|文本/ }[value.format];
    return (
      label.test(request) &&
      (!value.chart_type ||
        { bar: /柱状/, line: /折线/, pie: /饼图/ }[value.chart_type].test(request))
    );
  }
  if (value.type === "metric") return request.includes(value.metric_id);
  if (value.type === "grouping") return value.fields.every((field) => request.includes(field));
  if (value.type === "time_range" && value.range.type === "fixed")
    return request.includes(value.range.start) && request.includes(value.range.end);
  // 复杂结构要求用户显式点名键及完整条件，避免把单次查询当成覆盖默认的授权。
  return request.includes(input.key) && request.includes(JSON.stringify(value));
}

export { isExplicitPreferenceRequest };
