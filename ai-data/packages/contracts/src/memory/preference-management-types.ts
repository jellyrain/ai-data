import type { z } from "zod";
import type { preferenceEditStateSchema } from "./preference-management";
/** 当前账号创建、编辑和重新设置偏好的版本基准。 */
type PreferenceEditState = z.infer<typeof preferenceEditStateSchema>;
export type { PreferenceEditState };
