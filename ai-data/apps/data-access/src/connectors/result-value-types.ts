import type { QueryResult } from "@ai-data/contracts";

/** 结果列使用的标准 JSON 类型。 */
type ResultDataType = QueryResult["columns"][number]["data_type"];

/** 驱动 Date 对象表达时间点、无时区日期时间或 UTC 编码纯时间的方式。 */
type ResultDateMode = "instant" | "utc_wall" | "local_wall" | "utc_time";

export type { ResultDataType, ResultDateMode };
