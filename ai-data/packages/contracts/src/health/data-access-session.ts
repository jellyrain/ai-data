import { z } from "zod";
import { dateTimeSchema } from "../shared/data-values";

/** DAS 凭实例密钥领取接入 JWT 的请求；密钥放在 Bearer 请求头，正文仅声明实例。 */
const dataAccessCredentialRequestSchema = z
  .object({
    /** 已在 API 配置中批准的实例标识，上限与管理路由一致。 */
    service_id: z.string().min(1, "service_id 不能为空").max(128),
  })
  .strict();

/** 自动领取的结果仅供进程注册使用；拒绝额外字段，限制异常响应的凭据体积。 */
const dataAccessCredentialResponseSchema = dataAccessCredentialRequestSchema.extend({
  /** API 签发、绑定实例与当前凭据版本的注册 JWT。 */
  credential: z.string().min(1, "credential 不能为空").max(16384),
});

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

export {
  dataAccessSessionSchema,
  dataAccessHeartbeatAckSchema,
  dataAccessCredentialRequestSchema,
  dataAccessCredentialResponseSchema,
};
