import type { z } from "zod";
import type {
  datasetColumnSchema,
  datasetSchema,
  freshnessSchema,
  queryCapabilitiesSchema,
  queryConditionCapabilitySchema,
  queryParameterSchema,
  queryValueDefinitionSchema,
} from "./dataset";

/** 数据集字段元数据类型。 */
type DatasetColumn = z.infer<typeof datasetColumnSchema>;
/** 完整数据集目录类型。 */
type Dataset = z.infer<typeof datasetSchema>;
/** 数据新鲜度信息类型。 */
type Freshness = z.infer<typeof freshnessSchema>;
/** 存储过程或 HTTP API 输入参数类型。 */
type QueryParameter = z.infer<typeof queryParameterSchema>;
/** 字段条件和输入参数共用的值定义类型。 */
type QueryValueDefinition = z.infer<typeof queryValueDefinitionSchema>;
/** 数据集基础查询能力类型。 */
type QueryCapabilities = z.infer<typeof queryCapabilitiesSchema>;
/** 单条查询条件能力类型。 */
type QueryConditionCapability = z.infer<typeof queryConditionCapabilitySchema>;

export type {
  Dataset,
  DatasetColumn,
  Freshness,
  QueryCapabilities,
  QueryConditionCapability,
  QueryParameter,
  QueryValueDefinition,
};
