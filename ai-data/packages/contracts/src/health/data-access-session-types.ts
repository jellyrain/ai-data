import type { z } from "zod";
import type {
  dataAccessSessionSchema,
  dataAccessCredentialRequestSchema,
  dataAccessCredentialResponseSchema,
} from "./data-access-session";

/** DAS 注册成功后持有的心跳会话。 */
type DataAccessSession = z.infer<typeof dataAccessSessionSchema>;

/** DAS 使用配置密钥领取凭据时声明的实例身份。 */
type DataAccessCredentialRequest = z.infer<typeof dataAccessCredentialRequestSchema>;
/** API 自动签发的实例接入凭据。 */
type DataAccessCredentialResponse = z.infer<typeof dataAccessCredentialResponseSchema>;

export type { DataAccessSession, DataAccessCredentialRequest, DataAccessCredentialResponse };
