import type { z } from "zod";
import type { dataAccessHeartbeatSchema, sourceHealthSchema } from "./health";

/** 单个数据源健康状态类型。 */
type SourceHealth = z.infer<typeof sourceHealthSchema>;
/** Data Access Service 心跳类型。 */
type DataAccessHeartbeat = z.infer<typeof dataAccessHeartbeatSchema>;

export type { DataAccessHeartbeat, SourceHealth };
