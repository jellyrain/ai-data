import { z } from "zod";
import { dateSchema, dateTimeSchema } from "../shared/data-values";
import { filterConditionSchema } from "../query/query-dsl";
import { memoryScopeSchema, memorySourceSchema } from "./memory-common";

const id = z.string().min(1).max(128);
const field = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/);
/** 相对日历范围在使用时按东八区计算；固定日期保持原值，端点包含在范围内。 */
const preferenceTimeRangeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("relative"),
      period: z.enum(["this_year", "this_quarter", "this_month", "last_year", "last_month"]),
      extent: z.enum(["full_period", "to_date"]).default("full_period"),
    })
    .strict(),
  z
    .object({ type: z.literal("fixed"), start: dateSchema, end: dateSchema })
    .strict()
    .refine((value) => value.start <= value.end, "起点不能晚于终点"),
]);
/** 个人偏好只保存受控条件和展示方式；查询习惯保存可复用的查询结构。 */
const userPreferenceValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metric"), metric_id: id }).strict(),
  z.object({ type: z.literal("time_range"), range: preferenceTimeRangeSchema }).strict(),
  z
    .object({
      type: z.literal("filters"),
      conditions: z.array(filterConditionSchema).min(1).max(50),
    })
    .strict(),
  z.object({ type: z.literal("grouping"), fields: z.array(field).min(1).max(50) }).strict(),
  z
    .object({
      type: z.literal("presentation"),
      format: z.enum(["table", "chart", "text"]),
      chart_type: z.enum(["bar", "line", "pie"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("query_habit"),
      metric_id: id.optional(),
      time_range: preferenceTimeRangeSchema.optional(),
      filters: z.array(filterConditionSchema).max(50).default([]),
      dimensions: z.array(field).max(50).default([]),
    })
    .strict(),
]);
/** 个人设置拒绝确认标记等未知字段；字段条件必须限定对象，避免跨业务误用。 */
const userPreferenceInputSchema = z
  .object({
    key: id,
    scope: memoryScopeSchema.default({}),
    value: userPreferenceValueSchema,
    auto_apply: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.value.type === "filters" ||
        value.value.type === "grouping" ||
        value.value.type === "query_habit") &&
      !value.scope.object_id &&
      !value.scope.metric_id
    )
      context.addIssue({ code: "custom", message: "字段条件及查询习惯必须指定对象或指标范围" });
    if (JSON.stringify(value).length > 16000)
      context.addIssue({ code: "custom", message: "单条个人记忆超过容量限制" });
  });
/** 持久化个人记忆始终绑定组织与账号，版本用于并发更新，频次用于查询习惯整理。 */
const userPreferenceSchema = userPreferenceInputSchema.safeExtend({
  organization_id: id,
  user_id: id,
  version: z.number().int().positive(),
  source: memorySourceSchema,
  updated_at: dateTimeSchema,
  use_count: z.number().int().nonnegative(),
  last_used_at: dateTimeSchema.nullable(),
});
/** 写入请求的幂等键及预期版本；零表示预期此前不存在该键。 */
const saveUserPreferenceInputSchema = userPreferenceInputSchema.safeExtend({
  idempotency_key: id,
  expected_version: z.number().int().nonnegative().optional(),
});
/** 按需确认的记录绑定原版本、拟写入内容和来源，模型不能直接将其标记为已同意。 */
const preferenceConfirmationSchema = z
  .object({
    confirmation_id: id,
    organization_id: id,
    user_id: id,
    expected_version: z.number().int().nonnegative(),
    proposed: userPreferenceInputSchema,
    source: memorySourceSchema,
    reason: z.enum(["conflict", "auto_apply_disabled"]),
    status: z.enum(["pending", "accepted", "rejected"]),
    created_at: dateTimeSchema,
  })
  .strict();
/** 保存成功立即返回当前记忆；需要确认时返回可供会话澄清绑定的固定事项。 */
const saveUserPreferenceResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), preference: userPreferenceSchema }).strict(),
  z
    .object({
      status: z.literal("confirmation_required"),
      confirmation: preferenceConfirmationSchema,
    })
    .strict(),
]);
export {
  preferenceTimeRangeSchema,
  userPreferenceValueSchema,
  userPreferenceInputSchema,
  userPreferenceSchema,
  saveUserPreferenceInputSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceResultSchema,
};
