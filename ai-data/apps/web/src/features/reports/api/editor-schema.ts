import { z } from "zod";
import { datasetSchema, metricDefinitionSchema } from "@ai-data/contracts";
/** 编辑器只接收当前身份授权后的目录和指标。 */
const editorDatasetListSchema = z.object({ items: z.array(datasetSchema) }).strict();
const editorMetricListSchema = z.object({ items: z.array(metricDefinitionSchema) }).strict();
export { editorDatasetListSchema, editorMetricListSchema };
