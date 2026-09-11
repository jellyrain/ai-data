import type { z } from "zod";
import type {
  describeDatasetInputSchema,
  describeDatasetOutputSchema,
  listDatasetsInputSchema,
  listDatasetsOutputSchema,
  queryDatasetInputSchema,
  queryDatasetOutputSchema,
  searchCatalogInputSchema,
  searchCatalogOutputSchema,
} from "./api-tools";

/** search_catalog 工具输入类型。 */
type SearchCatalogInput = z.infer<typeof searchCatalogInputSchema>;
/** search_catalog 工具输出类型。 */
type SearchCatalogOutput = z.infer<typeof searchCatalogOutputSchema>;
/** list_datasets 工具输入类型。 */
type ListDatasetsInput = z.infer<typeof listDatasetsInputSchema>;
/** list_datasets 工具输出类型。 */
type ListDatasetsOutput = z.infer<typeof listDatasetsOutputSchema>;
/** describe_dataset 工具输入类型。 */
type DescribeDatasetInput = z.infer<typeof describeDatasetInputSchema>;
/** describe_dataset 工具输出类型。 */
type DescribeDatasetOutput = z.infer<typeof describeDatasetOutputSchema>;
/** query_dataset 工具输入类型。 */
type QueryDatasetInput = z.infer<typeof queryDatasetInputSchema>;
/** query_dataset 工具输出类型。 */
type QueryDatasetOutput = z.infer<typeof queryDatasetOutputSchema>;

export type {
  DescribeDatasetInput,
  DescribeDatasetOutput,
  ListDatasetsInput,
  ListDatasetsOutput,
  QueryDatasetInput,
  QueryDatasetOutput,
  SearchCatalogInput,
  SearchCatalogOutput,
};
