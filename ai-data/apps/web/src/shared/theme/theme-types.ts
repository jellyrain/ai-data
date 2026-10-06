import type { z } from "zod";
import type { themeSchema } from "./theme-schema";

/** 外观偏好的校验后类型。 */
type ThemePreference = z.infer<typeof themeSchema>;

export type { ThemePreference };
