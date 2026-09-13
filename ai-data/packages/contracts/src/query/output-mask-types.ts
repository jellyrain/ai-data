import type { z } from "zod";

import type { maskingRuleSchema } from "./output-mask";

/** API 签发并由 DAS 在结果出口执行的脱敏规则类型。 */
type MaskingRule = z.infer<typeof maskingRuleSchema>;

export type { MaskingRule };
