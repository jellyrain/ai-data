import type { z } from "zod";

import type { procedureDefinitionSchema } from "./procedure-definition";

/** 本地管理员审核并持久化的固定过程调用定义。 */
type ProcedureDefinition = z.infer<typeof procedureDefinitionSchema>;

export type { ProcedureDefinition };
