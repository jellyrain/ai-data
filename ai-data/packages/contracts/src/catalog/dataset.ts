import { z } from "zod";
import { queryOperatorSchema } from "../query/query-operators";
import { dataTypeSchema, isDataValue } from "../shared/data-values";

/** 数据目录中的对象名、字段名和关系字段引用。 */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

/** Data 为字段或输入参数提供的统一查询值定义。 */
const queryValueDefinitionSchema = z
  .object({
    /** 字段名或输入参数名。 */
    name: identifier,
    /** 允许使用的比较操作；API 可以进一步删减。 */
    allowed_ops: z.array(queryOperatorSchema).min(1),
    /** 条件值或参数值的业务数据类型。 */
    data_type: dataTypeSchema,
    /** 是否必须由调用方提供；存在默认值时可由默认值满足。 */
    required: z.boolean(),
    /** 调用方未提供值时使用的默认值；实际类型由 data_type 校验。 */
    default_value: z.unknown().optional(),
    /** 数据源对字段或参数的说明。 */
    source_description: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.default_value !== undefined && !isDataValue(value.default_value, value.data_type)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "default_value 必须符合 data_type",
      });
    }
  });

/** Data 为数据集字段提供的基础查询条件定义。 */
const queryConditionCapabilitySchema = queryValueDefinitionSchema;

/** Data 为字段提供的聚合能力定义。 */
const aggregationCapabilitySchema = z
  .object({
    /** 可聚合字段。 */
    field: identifier,
    /** 该字段允许使用的聚合函数。 */
    functions: z.array(z.enum(["count", "count_distinct", "sum", "avg", "min", "max"])).min(1),
  })
  .strict();

/** 数据集的基础查询能力；不填写某项表示该项不增加限制。 */
const queryCapabilitiesSchema = z
  .object({
    /** 可用过滤条件；table/view 未填写时默认全部字段使用标准操作。 */
    filter_conditions: z.array(queryConditionCapabilitySchema).optional(),
    /** 可排序字段；未填写时 table/view 默认全部字段可排序。 */
    sortable_fields: z.array(identifier).optional(),
    /** 可分组字段；未填写时 table/view 默认全部字段可分组。 */
    groupable_fields: z.array(identifier).optional(),
    /** 可用聚合能力；未填写时 table/view 默认使用标准聚合。 */
    aggregations: z.array(aggregationCapabilitySchema).optional(),
  })
  .strict();

/** 数据集字段的标准化元数据。 */
const datasetColumnSchema = z
  .object({
    /** 数据源中的真实字段名。 */
    name: identifier,
    /** 数据源字段注释或接口描述。 */
    source_description: z
      /** 说明只来自连接器可发现的源元数据，不代表 API 业务口径。 */
      .string()
      .optional(),
    /** 标准化后的数据类型。 */
    data_type: dataTypeSchema,
    /** 是否允许空值。 */
    nullable: z.boolean(),
  })
  /** 禁止目录服务返回合同之外的字段。 */
  .strict();

/** 非关系型输入数据集向 API 声明的调用参数，不等同于最终返回列。 */
const queryParameterSchema = queryValueDefinitionSchema;

/** 数据源报告的数据新鲜度。 */
const freshnessSchema = z
  .object({
    /** 最近一次数据更新时间，使用东八区格式。 */
    observed_at: z
      /** 时间不能为空；具体格式由连接器按数据源约定返回。 */
      .string()
      .min(1),
    /** 新鲜度来源。 */
    source: z
      /** 说明新鲜度是探测得到、接口返回、配置提供还是未知。 */
      .enum(["database", "api", "configured", "unknown"]),
  })
  /** 禁止新鲜度对象出现未定义字段。 */
  .strict();

/** describe_dataset 返回的完整数据集目录。 */
const datasetSchema = z
  .object({
    /** 数据源配置标识，用于定位数据源。 */
    source_id: z.string().min(1),
    /** 数据源内对象引用，用于定位表、视图、存储过程或 API 资源。 */
    object_id: identifier,
    /** 数据集展示名称。 */
    name: z.string().min(1),
    /** 底层对象的真实类型；无论类型如何，返回结构都统一为扁平表。 */
    kind: z.enum(["table", "view", "stored_procedure", "api_dataset"]),
    /** 数据库 Schema 名称；非数据库数据集可以没有。 */
    schema_name: z.string().optional(),
    /** 数据源注释或接口描述；不代表 API 配置的业务口径。 */
    source_description: z.string().optional(),
    /** 当前数据集的字段元数据。 */
    columns: z.array(datasetColumnSchema),
    /** Data 提供的基础查询能力；API 可通过同名配置进一步收窄。 */
    query_capabilities: queryCapabilitiesSchema.optional(),
    /** 存储过程或 HTTP API 的输入参数；普通表通常为空。 */
    query_parameters: z.array(queryParameterSchema).default([]),
    /** 当前数据集的数据新鲜度。 */
    freshness: freshnessSchema.optional(),
  })
  /** 禁止完整目录出现未定义字段。 */
  .strict();

export {
  dataTypeSchema,
  aggregationCapabilitySchema,
  datasetColumnSchema,
  datasetSchema,
  freshnessSchema,
  queryCapabilitiesSchema,
  queryConditionCapabilitySchema,
  queryParameterSchema,
  queryValueDefinitionSchema,
};
