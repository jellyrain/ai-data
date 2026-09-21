import type { z } from "zod";
import type { memoryScopeSchema, memorySourceSchema } from "./memory-common";
import type {
  preferenceTimeRangeSchema,
  userPreferenceValueSchema,
  userPreferenceInputSchema,
  userPreferenceSchema,
  saveUserPreferenceInputSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceResultSchema,
} from "./user-preference";
/** 已校验的业务适用范围。 */
type MemoryScope = z.infer<typeof memoryScopeSchema>;
/** 已校验的记忆来源引用。 */
type MemorySource = z.infer<typeof memorySourceSchema>;
/** 日历相对范围或固定日期。 */
type PreferenceTimeRange = z.infer<typeof preferenceTimeRangeSchema>;
/** 可持久化的偏好值。 */
type UserPreferenceValue = z.infer<typeof userPreferenceValueSchema>;
/** 个人记忆的业务内容。 */
type UserPreferenceInput = z.infer<typeof userPreferenceInputSchema>;
/** 当前账号的一个记忆版本。 */
type UserPreference = z.infer<typeof userPreferenceSchema>;
/** 带幂等及乐观锁信息的保存输入。 */
type SaveUserPreferenceInput = z.infer<typeof saveUserPreferenceInputSchema>;
/** 等待真实用户决定的偏好变更。 */
type PreferenceConfirmation = z.infer<typeof preferenceConfirmationSchema>;
/** 个人记忆保存结果。 */
type SaveUserPreferenceResult = z.infer<typeof saveUserPreferenceResultSchema>;
export type {
  MemoryScope,
  MemorySource,
  PreferenceTimeRange,
  UserPreferenceValue,
  UserPreferenceInput,
  UserPreference,
  SaveUserPreferenceInput,
  PreferenceConfirmation,
  SaveUserPreferenceResult,
};
