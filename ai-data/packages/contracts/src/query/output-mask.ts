import { z } from "zod";

/** API 要求 DAS 在结果出口执行的字段脱敏规则。 */
const maskingRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("partial_mask"),
      prefix_length: z.number().int().min(0),
      suffix_length: z.number().int().min(0),
      mask_character: z.string().length(1).default("*"),
    })
    .strict(),
]);

/** 一条按最终结果列别名定位的脱敏指令。 */
const outputMaskSchema = z
  .object({
    result_column: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "必须是安全结果列名"),
    rule: maskingRuleSchema,
  })
  .strict();

export { maskingRuleSchema, outputMaskSchema };
