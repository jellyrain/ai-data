import type { z } from "zod";
import type { contractErrorCodeSchema, contractErrorSchema } from "./errors";

/** 跨服务共享的合同错误码类型。 */
type ContractErrorCode = z.infer<typeof contractErrorCodeSchema>;
/** 结构化合同错误类型。 */
type ContractError = z.infer<typeof contractErrorSchema>;

export type { ContractError, ContractErrorCode };
