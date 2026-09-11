import { z } from "zod";
import { maskingRuleSchema } from "../query/output-mask";
import { queryCapabilitiesSchema } from "./dataset";
import { queryOperatorSchema } from "../query/query-operators";

/** API 业务目录中引用的数据对象和字段标识。 */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

/** 一条 Join 关系中的字段等值条件；同一关系的多个条件使用 AND 连接。 */
const relationColumnPairSchema = z
  .object({
    /** 当前对象参与关联的真实字段名。 */
    source_column: identifier,
    /** 目标对象参与关联的真实字段名。 */
    target_column: identifier,
  })
  .strict();

/** API 明确批准的一条数据对象关联关系，可包含多个 AND 字段条件。 */
const approvedRelationSchema = z
  .object({
    /** 已批准关联的目标对象。 */
    target_object_id: identifier,
    /** 面向模型的关联业务语义；同一对对象可配置多条不同关系。 */
    description: z.string().min(1),
    /** 组成 Join 的字段等值条件，执行时使用 AND 连接。 */
    column_pairs: z.array(relationColumnPairSchema).min(1),
  })
  .strict();

/** API 对数据集字段维护的业务说明。 */
const apiDatasetColumnDescriptionSchema = z
  .object({
    /** 数据源中的真实字段名。 */
    field: identifier,
    /** 面向业务用户和 Agent 的字段说明。 */
    business_description: z.string().min(1),
  })
  .strict();

/** API 对数据集字段维护的默认脱敏和免脱敏角色配置。 */
const apiDatasetColumnPolicySchema = z
  .object({
    /** 数据源中的真实字段名。 */
    field: identifier,
    /** 未命中特殊角色时使用的默认结果处理规则。 */
    default_masking: maskingRuleSchema,
    /** 允许申请原样返回该字段的角色配置标识；最终是否生效由 API 权限计算决定。 */
    unmasked_role_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** API 对 Data 输入参数的收窄策略，可补充默认值但不能扩大 Data 能力。 */
const queryParameterPolicySchema = z
  .object({
    /** 对应 dataset.query_parameters 中的参数名。 */
    name: identifier,
    /** API 允许的操作子集；未填写时继承 Data。 */
    allowed_ops: z.array(queryOperatorSchema).min(1).optional(),
    /** API 是否要求调用方提供；只能收紧 Data 的 required 语义。 */
    required: z.boolean().optional(),
    /** API 为省略参数提供的默认值；类型必须符合 Data 的 data_type。 */
    default_value: z.unknown().optional(),
  })
  .strict();

/** API 维护的数据集业务配置，不由 Data Access Service 推断或返回。 */
const apiDatasetConfigSchema = z
  .object({
    /** 数据源配置标识，用于定位数据源。 */
    source_id: z.string().min(1),
    /** 数据源内对象引用，用于定位表、视图或 API 资源。 */
    object_id: identifier,
    /** API 维护的业务说明。 */
    business_description: z.string().optional(),
    /** API 确认的一行数据业务粒度。 */
    grain: z.string().optional(),
    /** API 明确批准的关联关系；默认不允许推断关系。 */
    approved_relations: z.array(approvedRelationSchema).default([]),
    /** API 收窄 Data 基础查询能力；未配置时继承 Data，空数组表示明确禁止对应能力。 */
    query_capabilities: queryCapabilitiesSchema.optional(),
    /** API 对存储过程/API 输入参数的收窄和默认值配置；未配置时继承 Data。 */
    query_parameter_policies: z.array(queryParameterPolicySchema).optional(),
    /** API 维护的字段业务说明；未配置字段沿用数据源字段注释或为空。 */
    column_descriptions: z.array(apiDatasetColumnDescriptionSchema).default([]),
    /** API 配置的字段默认脱敏策略；未配置字段默认不附加脱敏规则。 */
    column_policies: z.array(apiDatasetColumnPolicySchema).default([]),
  })
  .strict();

export {
  apiDatasetColumnDescriptionSchema,
  apiDatasetColumnPolicySchema,
  apiDatasetConfigSchema,
  approvedRelationSchema,
  queryParameterPolicySchema,
  relationColumnPairSchema,
};
