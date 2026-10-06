import type { z } from "zod";
import type { sourceListInputSchema, sourceListSchema } from "./source-list";
/** 已校验的源列表分页请求。 */
type SourceListInput = z.infer<typeof sourceListInputSchema>;
/** 当前身份可见的源摘要及下一页游标。 */
type SourceList = z.infer<typeof sourceListSchema>;
export type { SourceListInput, SourceList };
