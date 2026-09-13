import { z } from "zod";
import { dateTimeSchema } from "../shared/data-values";

/** API 完成 DAS 注册后返回的会话，只由服务进程保存。 */
const dataAccessSessionSchema = z
  .object({
    /** 会话所属的 DAS 实例。 */
    service_id: z.string().min(1),
    /** 32 字节随机值的 Base64URL 表达，作为后续心跳的 Bearer 凭据。 */
    session_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    /** 最近一次有效心跳之后的会话空闲上限，单位秒。 */
    session_timeout_seconds: z.number().int().positive(),
  })
  .strict();

/** API 对已接受心跳的确认，时间由接收方生成。 */
const dataAccessHeartbeatAckSchema = z
  .object({
    service_id: z.string().min(1),
    accepted_at: dateTimeSchema,
  })
  .strict();

export { dataAccessSessionSchema, dataAccessHeartbeatAckSchema };
