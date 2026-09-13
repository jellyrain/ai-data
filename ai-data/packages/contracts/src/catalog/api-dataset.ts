import { z } from "zod";
import { maskingRuleSchema } from "../query/output-mask";
import { queryCapabilitiesSchema } from "./dataset";
import { queryOperatorSchema } from "../query/query-operators";

/** API 业务目录引用的对象和字段格式；存在性与授权范围在使用目录时检查。 */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

/** Join 关系中的字段等值条件，仅接受声明字段；同一关系的多个条件使用 AND 连接。 */
const relationColumnPairSchema = z
  .object({
    /** 当前对象参与关联的真实字段名。 */
    source_column: identifier,
    /** 目标对象参与关联的真实字段名。 */
    target_column: identifier,
  })
  .strict();

/** 从当前对象到目标对象的关联基数，用于 API 判断业务记录是否会因关联重复。 */
const relationCardinalitySchema = z.enum([
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
]);

/** API 明确批准的对象关联关系，仅接受声明字段；至少提供一组字段等值条件。 */
const approvedRelationSchema = z
  .object({
    /** 当前数据集配置内唯一的关系标识；省略时由 API 按字段等值条件匹配关系。 */
    relation_id: identifier.min(1, "relation_id 不能为空").optional(),
    /** 已批准关联的目标对象。 */
    target_object_id: identifier,
    /** 面向模型的关联业务语义；同一对对象可配置多条不同关系。 */
    description: z.string().min(1),
    /** 组成 Join 的字段等值条件，执行时使用 AND 连接。 */
    column_pairs: z.array(relationColumnPairSchema).min(1),
    /** 管理员确认的当前对象到目标对象基数；省略时由 API 按可验证的唯一键判定。 */
    cardinality: relationCardinalitySchema.optional(),
  })
  .strict();

/** API 对数据集字段维护的业务说明，仅接受声明字段。 */
const apiDatasetColumnDescriptionSchema = z
  .object({
    /** 数据源中的真实字段名。 */
    field: identifier,
    /** 面向业务用户和 Agent 的字段说明。 */
    business_description: z.string().min(1),
  })
  .strict();

/** API 维护的字段默认脱敏及免脱敏角色配置，仅接受声明字段。 */
const apiDatasetColumnPolicySchema = z
  .object({
    /** 数据源中的真实字段名。 */
    field: identifier,
    /** 未命中特殊角色时使用的默认结果处理规则。 */
    default_masking: maskingRuleSchema,
    /** 可申请原样返回的角色；默认空列表，最终是否生效由 API 权限计算决定。 */
    unmasked_role_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** API 输入参数策略，仅接受声明字段；与 DAS 能力比较后的收窄校验由业务层负责。 */
const queryParameterPolicySchema = z
  .object({
    /** 对应 dataset.query_parameters 中的参数名。 */
    name: identifier,
    /** API 允许的操作子集；未填写时继承 Data。 */
    allowed_ops: z.array(queryOperatorSchema).min(1).optional(),
    /** API 是否要求调用方提供；省略时继承 DAS，业务层需检查是否只收紧 required 语义。 */
    required: z.boolean().optional(),
    /** API 为省略参数提供的默认值；业务层需结合 DAS 参数定义检查类型。 */
    default_value: z.unknown().optional(),
  })
  .strict();

/**
 * 管理员确认的数据源权限约束：调用该参数后，返回记录的字段必须与参数值精确相等。
 * 该保证来自已验收的数据源实现；API 只接受声明字段，并以标量等值参数实施行范围。
 */
const queryPermissionBindingSchema = z
  .object({
    /** 固定输出中的真实字段，用于关联角色范围和强制身份范围。 */
    field: identifier,
    /** 数据源实际用于限制该字段的输入参数名。 */
    parameter: identifier,
    /** 当前支持的确定性绑定语义；空值和范围数组不能作为等值权限参数。 */
    operator: z.literal("eq"),
  })
  .strict();

/** API 维护的数据集业务配置，仅接受声明字段；与 DAS 的物理目录分开维护。 */
const apiDatasetConfigSchema = z
  .object({
    /** 数据源配置标识，用于定位数据源。 */
    source_id: z.string().min(1),
    /** 数据源内对象引用，用于定位表、视图或 API 资源。 */
    object_id: identifier,
    /** API 维护的可选业务说明，供目录展示与分析理解使用。 */
    business_description: z.string().optional(),
    /** API 确认的一行数据业务粒度；尚未配置时省略。 */
    grain: z.string().optional(),
    /** 每组字段共同唯一标识一行；省略或空列表表示尚未声明可用唯一键。 */
    unique_keys: z.array(z.array(identifier).min(1, "唯一键至少需要一个字段")).optional(),
    /** API 明确批准的关联关系；默认不允许推断关系。 */
    approved_relations: z.array(approvedRelationSchema).default([]),
    /** API 收窄 Data 基础查询能力；未配置时继承 Data，空数组表示明确禁止对应能力。 */
    query_capabilities: queryCapabilitiesSchema.optional(),
    /** API 对存储过程/API 输入参数的收窄和默认值配置；未配置时继承 Data。 */
    query_parameter_policies: z.array(queryParameterPolicySchema).optional(),
    /** 已验收的字段与权限参数绑定；省略时有行限制的参数化查询会被拒绝。最多 64 个字段。 */
    query_permission_bindings: z.array(queryPermissionBindingSchema).max(64).optional(),
    /** API 维护的字段业务说明；未配置字段沿用数据源字段注释或为空。 */
    column_descriptions: z.array(apiDatasetColumnDescriptionSchema).default([]),
    /** API 配置的字段默认脱敏策略；未配置字段默认不附加脱敏规则。 */
    column_policies: z.array(apiDatasetColumnPolicySchema).default([]),
  })
  .strict()
  // 唯一键按字段集合判重，关系标识唯一；权限绑定、参数收窄与字段脱敏分别保留唯一策略。
  .superRefine((config, context) => {
    const uniqueKeys = new Set<string>();
    for (const [index, fields] of (config.unique_keys ?? []).entries()) {
      if (new Set(fields).size !== fields.length) {
        context.addIssue({
          code: "custom",
          path: ["unique_keys", index],
          message: "唯一键中的字段不能重复",
        });
      }
      const key = JSON.stringify([...fields].sort());
      if (uniqueKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["unique_keys", index],
          message: "相同字段集合的唯一键不能重复",
        });
      }
      uniqueKeys.add(key);
    }
    const relationIds = new Set<string>();
    for (const [index, relation] of config.approved_relations.entries()) {
      if (relation.relation_id === undefined) continue;
      if (relationIds.has(relation.relation_id)) {
        context.addIssue({
          code: "custom",
          path: ["approved_relations", index, "relation_id"],
          message: "当前数据集配置中的关系标识不能重复",
        });
      }
      relationIds.add(relation.relation_id);
    }
    for (const key of ["field", "parameter"] as const) {
      const values = config.query_permission_bindings?.map((binding) => binding[key]) ?? [];
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          path: ["query_permission_bindings"],
          message: `权限绑定的 ${key} 不能重复`,
        });
    }
    const names = config.query_parameter_policies?.map((policy) => policy.name) ?? [];
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        path: ["query_parameter_policies"],
        message: "参数策略名称不能重复",
      });
    const columns = config.column_policies.map((policy) => policy.field);
    if (new Set(columns).size !== columns.length)
      context.addIssue({
        code: "custom",
        path: ["column_policies"],
        message: "字段脱敏策略不能重复",
      });
  });

export {
  apiDatasetColumnDescriptionSchema,
  apiDatasetColumnPolicySchema,
  apiDatasetConfigSchema,
  approvedRelationSchema,
  queryParameterPolicySchema,
  queryPermissionBindingSchema,
  relationCardinalitySchema,
  relationColumnPairSchema,
};
