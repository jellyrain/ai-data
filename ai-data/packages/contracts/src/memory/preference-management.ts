import { z } from "zod";
import { userPreferenceSchema } from "./user-preference";
/** 当前账号编辑偏好时的版本基准；删除状态不包含已删除的内容。 */
const preferenceEditStateSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("missing"), version: z.literal(0) }).strict(),
    z.object({ status: z.literal("deleted"), version: z.number().int().positive() }).strict(),
    z
      .object({
        status: z.literal("live"),
        version: z.number().int().positive(),
        preference: userPreferenceSchema,
      })
      .strict(),
  ])
  .superRefine((record, context) => {
    if (record.status === "live" && record.version !== record.preference.version)
      context.addIssue({ code: "custom", message: "偏好编辑基准与内容版本不一致" });
  });
export { preferenceEditStateSchema };
