import {
  apiDatasetConfigSchema,
  isDataValue,
  queryParameterSchema,
  type ApiDatasetConfig,
  type ContractErrorCode,
  type Dataset,
} from "@ai-data/contracts";

import { ApplicationError } from "../errors/application-error";

/** 校验管理员参数配置引用与收窄关系，返回实际执行时使用的完整参数定义。 */
function resolveParameterDefinitions(
  dataset: Dataset,
  config: ApiDatasetConfig | undefined,
  errorCode: ContractErrorCode = "POLICY_REJECTED",
): Dataset["query_parameters"] {
  const reject = (message: string): never => {
    throw new ApplicationError(errorCode, message);
  };
  if (config && !apiDatasetConfigSchema.safeParse(config).success) reject("数据集业务配置格式无效");
  const definitions = new Map(
    dataset.query_parameters.map((definition) => [definition.name, definition]),
  );
  if (
    definitions.size !== dataset.query_parameters.length ||
    !dataset.query_parameters.every(
      (definition) => queryParameterSchema.safeParse(definition).success,
    )
  )
    reject("数据集输入参数定义无效");
  for (const policy of config?.query_parameter_policies ?? []) {
    const definition = definitions.get(policy.name);
    if (!definition) throw new ApplicationError(errorCode, "参数策略引用的参数不存在");
    if (definition.required && policy.required === false) reject("参数策略不能放宽必填约束");
    if (policy.allowed_ops?.some((operator) => !definition.allowed_ops.includes(operator)))
      reject("参数策略不能扩大允许操作");
    if (
      policy.default_value !== undefined &&
      !isDataValue(policy.default_value, definition.data_type)
    )
      reject("参数策略默认值与参数类型不一致");
    definitions.set(policy.name, {
      ...definition,
      allowed_ops: policy.allowed_ops ?? definition.allowed_ops,
      required: policy.required ?? definition.required,
      ...(policy.default_value === undefined ? {} : { default_value: policy.default_value }),
    });
  }
  const bindings = config?.query_permission_bindings ?? [];
  if (bindings.length && dataset.kind !== "stored_procedure" && dataset.kind !== "api_dataset")
    reject("权限参数绑定只适用于参数化数据集");
  for (const binding of bindings) {
    const column = dataset.columns.find((item) => item.name === binding.field);
    const parameter = definitions.get(binding.parameter);
    if (
      !column ||
      !parameter ||
      column.data_type !== parameter.data_type ||
      !parameter.allowed_ops.includes("eq")
    )
      reject("权限绑定需要存在且类型相同的输出字段和等值输入参数");
  }
  return [...definitions.values()];
}

export { resolveParameterDefinitions };
