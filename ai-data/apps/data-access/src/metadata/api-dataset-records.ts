import { dataTypeSchema } from "@ai-data/contracts";
import { z } from "zod";

import { identifierSchema } from "../catalog/catalog-identifier";

/** HTTP API 响应中一个字段到统一表列的映射，仅接受声明字段。 */
const apiDatasetFieldMappingSchema = z
  .object({
    /** 返回给 API 的统一列名。 */
    name: identifierSchema,
    /** 只由管理员配置并在连接器内部使用的 JSONPath。 */
    json_path: z.string().regex(/^\$/, "json_path 必须以 $ 开头"),
    /** 输出列元数据声明的统一类型。 */
    data_type: dataTypeSchema,
    /** 原始 JSON 字段缺失时是否允许补 null。 */
    nullable: z.boolean(),
    /** 管理员可选配置的接口字段说明。 */
    source_description: z.string().optional(),
  })
  .strict();

/** 元数据库中 HTTP API 虚拟表定义的读取记录，仅接受声明字段。 */
const apiDatasetMappingRowSchema = z
  .object({
    /** 所属 HTTP API 数据源配置标识。 */
    source_id: z.string().min(1),
    /** 管理员配置并暴露给 API 的虚拟表标识。 */
    object_id: identifierSchema,
    /** 连接器允许调用的固定 HTTP 方法。 */
    request_method: z.enum(["GET", "POST"]),
    /** 相对于 secret_ref 中 base URL 的固定路径。 */
    request_path: z.string().regex(/^\//, "request_path 必须以 / 开头"),
    /** 输入参数映射的 JSON 持久化内容。 */
    request_parameter_mappings_json: z.string(),
    /** list 映射全部 JSONPath 匹配项，object 仅映射首项。 */
    response_mode: z.enum(["list", "object"]),
    /** 从原始响应定位数组或单个对象的管理员配置 JSONPath。 */
    response_path: z.string().regex(/^\$/, "response_path 必须以 $ 开头"),
    /** 响应字段映射的 JSON 持久化内容。 */
    field_mappings_json: z.string(),
  })
  .strict();

export { apiDatasetFieldMappingSchema, apiDatasetMappingRowSchema };
