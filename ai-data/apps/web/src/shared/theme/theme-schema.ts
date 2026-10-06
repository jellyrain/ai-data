import { z } from "zod";

/** 浏览器外观偏好，只保存明暗选择及配色标识。 */
const themeSchema = z
  .object({
    mode: z.enum(["light", "dark", "system"]),
    palette: z.enum(["olive", "blue", "teal", "violet"]),
  })
  .strict();

export { themeSchema };
