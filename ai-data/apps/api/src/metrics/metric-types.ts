import type { MetricDefinition } from "@ai-data/contracts";
interface MetricRepository {
  publish(organizationId: string, metric: MetricDefinition): Promise<void>;
  find(
    organizationId: string,
    metricId: string,
    version?: number,
  ): Promise<MetricDefinition | null>;
  list(organizationId: string): Promise<MetricDefinition[]>;
}
export type { MetricRepository };
