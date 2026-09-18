import type { z } from "zod";
import type { metricDefinitionSchema, metricExecutionInputSchema } from "./metric";
type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
type MetricExecutionInput = z.infer<typeof metricExecutionInputSchema>;
export type { MetricDefinition, MetricExecutionInput };
