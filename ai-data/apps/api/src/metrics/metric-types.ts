import type { MemoryScope, MetricDefinition } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type { ApiQueryAuthorization } from "../app-types";
/** 对外只读取已发布并已生效的指标定义。 */
interface MetricRepository {
  find(
    organizationId: string,
    metricId: string,
    version?: number,
  ): Promise<MetricDefinition | null>;
  list(organizationId: string): Promise<MetricDefinition[]>;
  findPublicationScope(
    organizationId: string,
    metricId: string,
    version: number,
  ): Promise<MemoryScope | null>;
}
/** 发布校验可以借用外层事务的目录授权，读取额外复核发布适用范围。 */
interface MetricDependencies {
  authorizeScope?(
    context: AuthContext,
    scope: MemoryScope,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  authorizationForExecutor?(executor: MetadataQueryExecutor): ApiQueryAuthorization;
}
export type { MetricRepository, MetricDependencies };
