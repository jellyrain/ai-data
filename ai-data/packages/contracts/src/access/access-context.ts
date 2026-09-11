import { z } from "zod";

import { dateTimeSchema } from "../shared/data-values";
import { outputMaskSchema } from "../query/output-mask";

/** API 已将查询授权条件合并进 query.filters 后传给 DAS 的审计上下文。 */
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
    /** API 签发查询权限的过期时间。 */
    expires_at: dateTimeSchema,
    /** API 已按权限策略计算、由 DAS 在返回前执行的结果脱敏规则。 */
    output_masks: z.array(outputMaskSchema).default([]),
  })
  .strict();

export { queryAccessContextSchema };
