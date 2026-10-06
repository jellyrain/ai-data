import { z } from "zod";
import { dateTimeSchema } from "../shared/data-values";
import { sourceHealthSchema } from "../health/health";
/** 实例管理只公开连接状态和心跳；凭证通过单独受限操作领取。 */
const managedDataAccessServiceSchema = z
  .object({
    service_id: z.string().min(1),
    service_url: z.string().url(),
    service_version: z.string().nullable(),
    status: z.enum(["healthy", "unhealthy"]),
    connection_status: z.enum(["online", "unhealthy", "offline"]),
    last_heartbeat_at: dateTimeSchema,
    sources: z.array(sourceHealthSchema),
  })
  .strict();
/** 目标目录的连接名由驱动返回，Oracle 同时声明连接方式。 */
const databaseTargetSchema = z
  .object({
    name: z.string().min(1),
    connect_target: z.string().min(1),
    connect_type: z.enum(["sid", "service_name"]).optional(),
  })
  .strict();
export { managedDataAccessServiceSchema, databaseTargetSchema };
