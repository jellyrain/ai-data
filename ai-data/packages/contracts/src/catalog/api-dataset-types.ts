import type { z } from "zod";
import {
  apiDatasetColumnDescriptionSchema,
  apiDatasetColumnPolicySchema,
  apiDatasetConfigSchema,
  approvedRelationSchema,
  queryParameterPolicySchema,
  relationColumnPairSchema,
} from "./api-dataset";

/** API 维护的数据集业务配置类型。 */
type ApiDatasetConfig = z.infer<typeof apiDatasetConfigSchema>;
/** API 明确批准的数据对象关联关系类型。 */
type ApprovedRelation = z.infer<typeof approvedRelationSchema>;
/** Join 关系中的字段对类型。 */
type RelationColumnPair = z.infer<typeof relationColumnPairSchema>;
/** API 输入参数收窄和默认值策略类型。 */
type QueryParameterPolicy = z.infer<typeof queryParameterPolicySchema>;
/** API 字段默认脱敏和免脱敏角色配置类型。 */
type ApiDatasetColumnPolicy = z.infer<typeof apiDatasetColumnPolicySchema>;
/** API 字段业务说明类型。 */
type ApiDatasetColumnDescription = z.infer<typeof apiDatasetColumnDescriptionSchema>;

export type {
  ApiDatasetColumnDescription,
  ApiDatasetColumnPolicy,
  ApiDatasetConfig,
  ApprovedRelation,
  RelationColumnPair,
  QueryParameterPolicy,
};
