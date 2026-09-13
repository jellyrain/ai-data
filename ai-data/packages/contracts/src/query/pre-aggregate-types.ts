import type { z } from "zod";

import type { preAggregateSchema, preAggregateSelectSchema } from "./pre-aggregate";

/** 单个对象在关联前按指定分组粒度产生的输出定义。 */
type PreAggregate = z.infer<typeof preAggregateSchema>;
/** 对象内分组字段或聚合结果的输出列定义。 */
type PreAggregateSelect = z.infer<typeof preAggregateSelectSchema>;

export type { PreAggregate, PreAggregateSelect };
