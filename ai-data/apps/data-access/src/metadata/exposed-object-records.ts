import { z } from "zod";

import { identifierSchema } from "../catalog/catalog-identifier";

/** 元数据库中一条本地对象白名单记录，仅接受声明字段。 */
const exposedObjectRowSchema = z
  .object({
    /** 所属数据源配置标识。 */
    source_id: z.string().min(1),
    /** API 可引用的逻辑对象标识。 */
    object_id: identifierSchema,
    /** 对象真实类型决定连接器发现和执行方式。 */
    object_kind: z.enum(["table", "view", "stored_procedure", "api_dataset"]),
    /** 数据库中真实 Schema；HTTP API 虚拟表允许没有该值。 */
    native_schema_name: z.string().min(1).nullable(),
    /** 数据库或虚拟表的真实对象名；未映射对象不能交给连接器。 */
    native_object_name: z.string().min(1).nullable(),
    /** 是否允许将对象纳入 API 可发现目录。 */
    is_discoverable: z.boolean(),
    /** 是否允许查询规划器把对象映射为最终 DSL。 */
    is_queryable: z.boolean(),
    /** 基础查询能力的 JSON 持久化内容。 */
    capabilities_json: z.string(),
    /** 管理员审核的过程签名 JSON；数据库 NULL 表示尚未配置。 */
    procedure_definition_json: z.string().nullable(),
  })
  .strict();

export { exposedObjectRowSchema };
