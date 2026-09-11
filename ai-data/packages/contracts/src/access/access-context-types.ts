import type { z } from "zod";

import type { queryAccessContextSchema } from "./access-context";

/** API 传给 DAS 的审计和结果脱敏授权上下文类型。 */
type QueryAccessContext = z.infer<typeof queryAccessContextSchema>;

export type { QueryAccessContext };
