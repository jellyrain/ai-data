import { z } from "zod";
import { queryDslSchema } from "../query/query-dsl";
import { datasetSchema } from "../catalog/dataset";
import { queryResultSchema } from "../query/query-result";

/** API 提供给模型的 search_catalog 工具输入合同。 */
const searchCatalogInputSchema = z
  .object({
    /** 要搜索的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 用户问题或业务关键词。 */
    query: z.string().min(1),
    /** 返回数量限制，默认 20，防止目录结果过大。 */
    limit: z.number().int().min(1).max(100).default(20),
  })
  /** 禁止工具调用附带未定义字段。 */
  .strict();

/** API 提供给模型的 search_catalog 工具输出合同。 */
const searchCatalogOutputSchema = z
  .object({
    /** 当前页连接器返回的原始数据集目录。 */
    items: z.array(datasetSchema),
    /** 存在下一页时返回的游标。 */
    next_cursor: z.string().optional(),
  })
  /** 禁止目录响应出现未定义字段。 */
  .strict();

/** API 提供给模型的 list_datasets 工具输入合同。 */
const listDatasetsInputSchema = z
  .object({
    /** 要列出的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 分页游标，首次请求可以省略。 */
    cursor: z.string().optional(),
    /** 返回数量限制，默认 20。 */
    limit: z.number().int().min(1).max(100).default(20),
  })
  /** 禁止列表请求出现未定义字段。 */
  .strict();

/** list_datasets 返回 API 维护的目录数据集列表。 */
const listDatasetsOutputSchema = searchCatalogOutputSchema;

/** API 提供给模型的 describe_dataset 工具输入合同。 */
const describeDatasetInputSchema = z
  .object({
    /** 要描述的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 要描述的数据源内对象引用。 */
    object_id: z.string().min(1),
  })
  /** 禁止描述请求出现未定义字段。 */
  .strict();

/** describe_dataset 返回 API 提供的数据集目录对象。 */
const describeDatasetOutputSchema = datasetSchema;

/** API 提供给模型的 query_dataset 工具输入合同，只接受结构化查询 DSL。 */
const queryDatasetInputSchema = z
  .object({
    /** 经过 queryDslSchema 校验的结构化查询。 */
    query: queryDslSchema,
  })
  /** 禁止查询工具输入携带自由 SQL 或其他未定义字段。 */
  .strict();
/** query_dataset 返回标准化结果和查询证据。 */
const queryDatasetOutputSchema = queryResultSchema;

export {
  describeDatasetInputSchema,
  describeDatasetOutputSchema,
  listDatasetsInputSchema,
  listDatasetsOutputSchema,
  queryDatasetInputSchema,
  queryDatasetOutputSchema,
  searchCatalogInputSchema,
  searchCatalogOutputSchema,
};
