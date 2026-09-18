import { z } from "zod";

/** 跨 API、Harness 和 Data Access Service 使用的统一错误码。 */
const contractErrorCodeSchema = z.enum([
  /** 请求体、查询 DSL 或其他输入不符合合同。 */
  "INVALID_INPUT",
  /** 请求未通过身份认证或访问令牌无效。 */
  "AUTHENTICATION_FAILED",
  /** 请求方没有访问目标资源的权限。 */
  "UNAUTHORIZED",
  /** 请求访问了未授权的数据对象。 */
  "UNAUTHORIZED_OBJECT",
  /** 请求使用了未授权的数据字段。 */
  "UNAUTHORIZED_COLUMN",
  /** 请求违反了已发布的权限策略或行过滤规则。 */
  "POLICY_REJECTED",
  /** 当前连接器不支持请求使用的查询能力。 */
  "UNSUPPORTED_QUERY",
  /** 查询超过最大行数、扫描量或其他资源上限。 */
  "QUERY_LIMIT_EXCEEDED",
  /** 查询在规定时间内未完成。 */
  "QUERY_TIMEOUT",
  /** 目标数据源当前不可用或连接失败。 */
  "DATA_SOURCE_UNAVAILABLE",
  /** 请求方触发了接口或数据源的速率限制。 */
  "RATE_LIMITED",
  /** 请求引用的资源不存在。 */
  "NOT_FOUND",
  /** 服务正在取消当前分析或查询。 */
  "CANCELLED",
  /** 幂等键、版本、运行状态或执行租约发生冲突。 */
  "CONFLICT",
  /** 服务内部发生未分类的处理错误。 */
  "INTERNAL_ERROR",
]);

/** 面向调用方的结构化合同错误，仅接受声明字段。 */
const contractErrorSchema = z
  .object({
    /** 统一错误码，供程序分支处理。 */
    code: contractErrorCodeSchema,
    /** 面向用户或日志的错误说明。 */
    message: z.string().min(1),
    /** 可选请求关联 ID，便于定位日志。 */
    request_id: z.string().min(1).optional(),
  })
  .strict();

export { contractErrorCodeSchema, contractErrorSchema };
