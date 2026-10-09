import { z } from "zod";

/**
 * API 要求 DAS 在结果出口执行的字段处理规则，按 type 区分原样返回和部分遮罩。
 * 每种规则仅接受对应的声明字段。
 */
const maskingRuleSchema = z.discriminatedUnion("type", [
  // none 表示该字段按原值返回。
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      /** 保留两端片段并遮罩中间内容。 */
      type: z.literal("partial_mask"),
      /** 原值开头保留的字符数，允许为 0。 */
      prefix_length: z.number().int().min(0),
      /** 原值末尾保留的字符数，允许为 0。 */
      suffix_length: z.number().int().min(0),
      /** 中间部分使用的单字符遮罩，省略时使用星号。 */
      mask_character: z.string().length(1).default("*"),
    })
    .strict(),
]);

/** 按最终结果列名定位的脱敏指令，仅接受声明字段。 */
const outputMaskSchema = z
  .object({
    /** SELECT 产生的最终列名或别名，供 DAS 匹配结果行中的键。 */
    result_column: z
      .string()
      .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*$/u, "必须是安全结果列名"),
    /** 该结果列采用的处理规则。 */
    rule: maskingRuleSchema,
  })
  .strict();

export { maskingRuleSchema, outputMaskSchema };
