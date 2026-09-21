import { z } from "zod";
import {
  dateTimeSchema,
  memorySourceSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceResultSchema,
  userPreferenceSchema,
} from "@ai-data/contracts";

const id = z.string().min(1).max(128);
/** 删除后只保留账号、键和递增版本；旧确认及后台任务据此拒绝写回。 */
const preferenceTombstoneSchema = z
  .object({
    organization_id: id,
    user_id: id,
    key: id,
    version: z.number().int().positive(),
    deleted_at: dateTimeSchema,
  })
  .strict();
/** 当前偏好与删除标记共用同一主键，持久化边界拒绝未知字段。 */
const preferenceRecordSchema = z.union([userPreferenceSchema, preferenceTombstoneSchema]);
/** SQL 投影同时读取身份和版本，供 JSON 内容一致性检查。 */
const preferenceRowSchema = z
  .object({
    organization_id: id,
    user_id: id,
    preference_key: id,
    version: z.number().int().positive(),
    preference_json: z.string(),
  })
  .strict();
/** 幂等响应覆盖保存、确认、管理及删除；删除与拒绝确认保存 null。 */
const preferenceOperationSchema = z
  .object({
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    result: z.union([saveUserPreferenceResultSchema, userPreferenceSchema, z.null()]),
  })
  .strict();
/** SQL Server ISJSON 接受对象文档；空响应同样通过对象封装存储。 */
const preferenceOperationResultSchema = z
  .object({ result: preferenceOperationSchema.shape.result })
  .strict();
/** 操作审计保存归属、动作和版本，来源引用按其访问边界另行校验。 */
const preferenceAuditSchema = z
  .object({
    audit_id: id,
    organization_id: id,
    user_id: id,
    key: id,
    action: z.enum([
      "save",
      "observe",
      "request_confirmation",
      "confirm",
      "reject",
      "delete",
      "auto_apply",
    ]),
    version: z.number().int().nonnegative(),
    at: dateTimeSchema,
    source: memorySourceSchema.optional(),
    confirmation_id: id.optional(),
  })
  .strict();
/** 仓储专用 JSON 列投影在解析内文前验证结构。 */
const preferenceJsonRowSchema = z.object({ record_json: z.string() }).strict();
/** 幂等表的两个字段共同复原已提交结果。 */
const preferenceOperationRowSchema = z
  .object({ request_hash: z.string(), result_json: z.string() })
  .strict();
/** 确认保留是否来源于查询观察，接受后才将该次查询计入新条件的频次。 */
const preferenceConfirmationRecordSchema = preferenceConfirmationSchema
  .extend({ is_observation: z.boolean() })
  .strict();
/** 来源登记与使用计数分开，工具先保存来源后仍可记录同一次实际查询。 */
const preferenceSourceRecordSchema = z
  .object({ source: memorySourceSchema, observed: z.boolean() })
  .strict();
/** 查询来源只读取持久化 JSON。 */
const preferenceSourceRowSchema = z.object({ source_json: z.string() }).strict();

export {
  preferenceTombstoneSchema,
  preferenceRecordSchema,
  preferenceRowSchema,
  preferenceOperationSchema,
  preferenceAuditSchema,
  preferenceJsonRowSchema,
  preferenceOperationRowSchema,
  preferenceConfirmationRecordSchema,
  preferenceSourceRecordSchema,
  preferenceSourceRowSchema,
  preferenceOperationResultSchema,
};
