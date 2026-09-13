import { z } from "zod";
import { dataTypeSchema, isDataValue } from "@ai-data/contracts";

import { identifierSchema } from "../catalog/catalog-identifier";

/** HTTP 虚拟表参数到固定请求位置的映射，仅接受声明字段。 */
const apiRequestParameterMappingSchema = z
  .object({
    /** 目录中已经审核的参数名称。 */
    name: identifierSchema,
    /** 参数只能进入管理员配置的请求位置。 */
    location: z.enum(["query", "header", "body"]),
    /** 外部 API 请求中使用的固定参数键。 */
    key: z.string().min(1),
    /** 可信输入类型，同时用于目录声明和调用校验。 */
    dataType: dataTypeSchema,
    /** 是否必须提供值；显式默认值可满足此约束。 */
    required: z.boolean(),
    /** 调用方省略时绑定的默认值，类型必须符合 dataType。 */
    defaultValue: z.unknown().optional(),
  })
  .strict()
  .superRefine((parameter, context) => {
    if (
      parameter.defaultValue !== undefined &&
      !isDataValue(parameter.defaultValue, parameter.dataType)
    ) {
      context.addIssue({ code: "custom", message: "参数默认值必须符合 dataType" });
    }
  });

export { apiRequestParameterMappingSchema };
