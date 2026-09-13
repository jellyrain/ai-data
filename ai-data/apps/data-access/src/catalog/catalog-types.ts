import type { queryCapabilitiesSchema } from "@ai-data/contracts";
import type { z } from "zod";
import type { ProcedureDefinition } from "./procedure-definition-types";

/** DAS 本地允许暴露给 API 的数据对象。 */
type ExposedSourceObject = {
  /** 所属数据源配置标识。 */
  sourceId: string;
  /** API 与审计使用的逻辑对象标识。 */
  objectId: string;
  /** 对象真实类型。 */
  objectKind: "table" | "view" | "stored_procedure" | "api_dataset";
  /** 数据库物理 Schema；HTTP API 虚拟表等无 Schema 的对象可省略。 */
  nativeSchemaName?: string;
  /** 数据库物理对象或虚拟表名；可查询规划要求此映射存在。 */
  nativeObjectName?: string;
  /** 是否可以出现在目录发现结果中。 */
  isDiscoverable: boolean;
  /** 是否可以用于最终查询规划。 */
  isQueryable: boolean;
  /** 管理员配置并经过 Schema 校验的基础能力。 */
  queryCapabilities: z.infer<typeof queryCapabilitiesSchema>;
  /** 管理员审核的过程完整输入和固定输出；省略时过程不能执行。 */
  procedureDefinition?: ProcedureDefinition;
};

export type { ExposedSourceObject };
