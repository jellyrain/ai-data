import { z } from "zod";

import { dateTimeSchema } from "../shared/data-values";
import { outputMaskSchema } from "../query/output-mask";

/** API 随最终查询签发的审计与结果脱敏上下文；仅接受合同声明的字段。 */
const queryAccessContextSchema = z
  .object({
    /** 发起本次查询的用户标识，用于 DAS 审计。 */
    user_id: z.string().min(1),
    /** 发起本次查询的组织标识，用于 DAS 审计。 */
    organization_id: z.string().min(1),
    /** API 分配的分析运行标识，用于 DAS 审计。 */
    analysis_run_id: z.string().min(1),
    /** API 权限策略版本，用于审计追溯。 */
    policy_version: z.number().int().positive(),
    /** 本次请求声明的授权截止时间，使用东八区文本；此处校验日期和时间格式。 */
    expires_at: dateTimeSchema,
    /** API 计算、由 DAS 在返回前执行的结果脱敏规则；省略时按空规则列表处理。 */
    output_masks: z.array(outputMaskSchema).default([]),
  })
  .strict();

export { queryAccessContextSchema };
