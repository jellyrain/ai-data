import { z } from "zod";

/** 按 source_id 关联的数据源健康快照；拒绝未声明字段。 */
const sourceHealthSchema = z
  .object({
    /** 数据源配置标识。 */
    source_id: z.string().min(1),
    /** 当前数据源连接状态。 */
    status: z.enum(["healthy", "unhealthy", "unknown"]),
    /** 健康检查发生时间。 */
    checked_at: z.string().min(1),
    /** 探测失败或有补充信息时提供的状态说明。 */
    message: z.string().optional(),
  })
  .strict();

/** Data Access Service 向 API 报告的服务心跳；拒绝未声明字段。 */
const dataAccessHeartbeatSchema = z
  .object({
    /** Data Access Service 实例标识。 */
    service_id: z.string().min(1),
    /** DAS 实例的 HTTP 或 HTTPS 监听端口；API 以心跳连接的远端地址和该端口生成调用地址。 */
    service_port: z.number().int().min(1).max(65535),
    /** DAS 从实际监听地址识别并上报的服务协议。 */
    service_protocol: z.enum(["http", "https"]),
    /** 服务当前是否可以接收查询请求。 */
    status: z.enum(["healthy", "unhealthy"]),
    /** 心跳发送时间。 */
    sent_at: z.string().min(1),
    /** 可选运行版本，供 API 记录和排查实例差异。 */
    service_version: z.string().min(1).optional(),
    /** 当前已配置数据源的健康快照；省略时按空快照列表处理。 */
    sources: z.array(sourceHealthSchema).default([]),
    /** 服务异常或有补充信息时提供的说明。 */
    message: z.string().optional(),
  })
  .strict();

export { dataAccessHeartbeatSchema, sourceHealthSchema };
