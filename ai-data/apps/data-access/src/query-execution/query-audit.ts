import { z } from "zod";

import { identifierSchema } from "../catalog/catalog-identifier";

/** 审计仓储接受的查询处理事件；外层拒绝未知字段，摘要内容由事件生产方整理。 */
const queryAuditEntrySchema = z
  .object({
    /** API 与 DAS 全链路使用的请求关联标识。 */
    correlationId: z.string().min(1),
    /** API 创建的分析运行标识；基础拒绝可能发生在尚未解析该字段之前。 */
    analysisRunId: z.string().min(1).optional(),
    /** 本次访问的 API 用户标识；JWT 失败时可能不可用。 */
    userId: z.string().min(1).optional(),
    /** 本次访问的组织标识；JWT 失败时可能不可用。 */
    organizationId: z.string().min(1).optional(),
    /** API 签发的最终策略版本；无有效访问上下文时允许缺失。 */
    policyVersion: z.number().int().positive().optional(),
    /** 实际选择或尝试选择的数据源；早期拒绝时允许缺失。 */
    sourceId: z.string().min(1).optional(),
    /** 本次查询涉及的逻辑对象，默认空数组用于早期拒绝。 */
    objectIds: z.array(identifierSchema).default([]),
    /** 由生产方选取的 DSL 摘要；默认空对象用于早期拒绝，内容需在构造时控制。 */
    querySummary: z.record(z.string(), z.unknown()).default({}),
    /** 由生产方脱敏后的参数摘要；默认空对象用于早期拒绝，本层不检查摘要内部内容。 */
    parametersSummary: z.record(z.string(), z.unknown()).default({}),
    /** 由生产方记录最终查询是否含 API 行过滤；省略时记为 false。 */
    rowFilterInjected: z.boolean().default(false),
    /** DAS 请求的最终处理结果，用于审计、失败率和告警。 */
    outcome: z.enum(["executed", "rejected", "timed_out", "failed"]),
    /** 实际返回行数，仅成功执行后可用。 */
    rowCount: z.number().int().nonnegative().optional(),
    /** 从接收请求至完成处理的耗时，单位毫秒。 */
    durationMs: z.number().int().nonnegative().optional(),
    /** 拒绝路径的可审计原因；成功执行时无需填写。 */
    rejectionReason: z.string().min(1).optional(),
    /** 可供 API 归类的稳定错误码；成功执行时无需填写。 */
    errorCode: z.string().min(1).optional(),
  })
  .strict();

export { queryAuditEntrySchema };
