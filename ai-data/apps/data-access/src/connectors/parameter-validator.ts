import { isDataValue, queryParameterSchema, type QueryParameter } from "@ai-data/contracts";

import type { ExecutableParameterizedQuery } from "./executable-query";

/** 依据可信目录验证完整参数集合，按定义顺序返回参数并补齐显式默认值。 */
function resolveParameters(
  definitions: QueryParameter[],
  provided: ExecutableParameterizedQuery["parameters"],
): ExecutableParameterizedQuery["parameters"] {
  const names = new Set<string>();
  const values = new Map<string, ExecutableParameterizedQuery["parameters"][number]>();
  for (const definition of definitions) {
    queryParameterSchema.parse(definition);
    if (names.has(definition.name)) throw new Error("参数定义不能重复");
    names.add(definition.name);
  }
  for (const parameter of provided) {
    if (!names.has(parameter.name)) throw new Error(`未知参数: ${parameter.name}`);
    if (values.has(parameter.name)) throw new Error(`参数不能重复: ${parameter.name}`);
    values.set(parameter.name, parameter);
  }
  return definitions.flatMap((definition) => {
    const parameter = values.get(definition.name);
    const value = parameter === undefined ? definition.default_value : parameter.value;
    if (value === undefined) {
      if (definition.required) throw new Error(`缺少必填参数: ${definition.name}`);
      return [];
    }
    if (
      (parameter !== undefined && parameter.data_type !== definition.data_type) ||
      !isDataValue(value, definition.data_type)
    ) {
      throw new Error(`参数类型不符: ${definition.name}`);
    }
    return [{ name: definition.name, data_type: definition.data_type, value }];
  });
}

export { resolveParameters };
