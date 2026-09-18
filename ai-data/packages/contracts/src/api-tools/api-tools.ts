import { z } from "zod";
import { queryDslSchema } from "../query/query-dsl";
import { datasetSchema } from "../catalog/dataset";
import { queryResultSchema } from "../query/query-result";
import { saveReportInputSchema, savedReportSchema } from "../reports/report";

/** search_catalog 的检索条件；仅接受声明字段，最多返回 100 项目录结果。 */
const searchCatalogInputSchema = z
  .object({
    /** 要搜索的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 用户问题或业务关键词。 */
    query: z.string().min(1),
    /** 返回数量限制，默认 20，防止目录结果过大。 */
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

/** search_catalog 的分页目录响应，仅接受声明字段。 */
const searchCatalogOutputSchema = z
  .object({
    /** 当前页的数据集目录条目，按共享数据集合同返回。 */
    items: z.array(datasetSchema),
    /** 存在下一页时返回的游标。 */
    next_cursor: z.string().optional(),
  })
  .strict();

/** list_datasets 的分页条件；仅接受声明字段，最多返回 100 项目录结果。 */
const listDatasetsInputSchema = z
  .object({
    /** 要列出的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 分页游标，首次请求可以省略。 */
    cursor: z.string().optional(),
    /** 每页条目数，默认 20，最多 100，以限制目录响应体积。 */
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

/** list_datasets 返回 API 维护的目录数据集列表。 */
const listDatasetsOutputSchema = searchCatalogOutputSchema;

/** describe_dataset 使用的数据源和对象定位信息，仅接受声明字段。 */
const describeDatasetInputSchema = z
  .object({
    /** 要描述的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 要描述的数据源内对象引用。 */
    object_id: z.string().min(1),
  })
  .strict();

/** describe_dataset 返回 API 提供的数据集目录对象。 */
const describeDatasetOutputSchema = datasetSchema;

/** query_dataset 的查询入口，仅接受声明的结构化 DSL 字段。 */
const queryDatasetInputSchema = z
  .object({
    /** 经过 queryDslSchema 校验的结构化查询。 */
    query: queryDslSchema,
  })
  .strict();
/** query_dataset 返回标准化列、结果行和截断等结果元数据。 */
const queryDatasetOutputSchema = queryResultSchema;

/** save_report 通过 API 关联运行证据并生成版本化快照。 */
const saveReportToolInputSchema = saveReportInputSchema;
const saveReportToolOutputSchema = savedReportSchema;

export {
  saveReportToolInputSchema,
  saveReportToolOutputSchema,
  describeDatasetInputSchema,
  describeDatasetOutputSchema,
  listDatasetsInputSchema,
  listDatasetsOutputSchema,
  queryDatasetInputSchema,
  queryDatasetOutputSchema,
  searchCatalogInputSchema,
  searchCatalogOutputSchema,
};
