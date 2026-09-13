import type { dataTypeSchema } from "@ai-data/contracts";
import type { z } from "zod";

import type { apiRequestParameterMappingSchema } from "./api-request-parameter-mapping";

/** HTTP API 连接器可执行的一张管理员配置虚拟表。 */
type ApiDatasetMapping = {
  /** 所属 HTTP API 数据源配置标识。 */
  sourceId: string;
  /** API 可查询的虚拟表标识。 */
  objectId: string;
  /** 连接器固定执行的 HTTP 请求定义。 */
  request: {
    /** 已审核的请求方法。 */
    method: "GET" | "POST";
    /** 相对于数据源 base URL 的固定路径。 */
    path: string;
    /** 目录参数到固定请求位置的映射。 */
    parameterMappings: Array<z.infer<typeof apiRequestParameterMappingSchema>>;
  };
  /** 原始响应到统一扁平表的受信任映射。 */
  response: {
    /** list 表示逐项映射；object 表示映射一次后包装为一行。 */
    mode: "list" | "object";
    /** 定位结果项的 JSONPath；list 消费全部匹配项，object 只消费首项。 */
    path: string;
    /** 每列的取值路径与结果类型声明。 */
    fields: Array<{
      /** 输出给 API 的统一列名。 */
      name: string;
      /** 仅在 HTTP API 连接器内部使用的 JSONPath。 */
      jsonPath: string;
      /** 输出列元数据声明的统一类型；取值路径本身不做类型转换。 */
      dataType: z.infer<typeof dataTypeSchema>;
      /** 原始字段缺失时是否可以输出空值。 */
      nullable: boolean;
      /** 可选的外部接口字段说明。 */
      sourceDescription?: string;
    }>;
  };
};

export type { ApiDatasetMapping };
