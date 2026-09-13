import type { z } from "zod";
import type { dataAccessSessionSchema } from "./data-access-session";

/** DAS 注册成功后持有的心跳会话。 */
type DataAccessSession = z.infer<typeof dataAccessSessionSchema>;

export type { DataAccessSession };
