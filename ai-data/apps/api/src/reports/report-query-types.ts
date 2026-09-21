import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { MetricDefinition, QueryDsl, ReportExecutionInput } from "@ai-data/contracts";
import type { ApiQueryAuthorization } from "../app-types";
import type { BusinessCatalogService } from "../catalog/business-catalog-service";
import type { MetricService } from "../metrics/metric-service";

/** 保存与运行共用的目录、指标及授权依赖，事务版本用于发布前复核。 */
type ReportQueryDependencies = {
  catalog: Pick<BusinessCatalogService, "getAuthorizedConfig" | "getAuthorized">;
  authorization: ApiQueryAuthorization;
  metrics: Pick<MetricService, "get">;
  forExecutor?: (executor: MetadataQueryExecutor) => Omit<ReportQueryDependencies, "forExecutor">;
  now?: () => number;
};
/** 最终 DSL 固定实际指标版本，结果引用仍使用查询项标识。 */
type BuiltReportQuery = {
  query_id: string;
  query: QueryDsl;
  metric?: Pick<MetricDefinition, "metric_id" | "version">;
};
/** 参数解析结果随执行保存，便于查看当时相对日期的实际范围。 */
type BuiltReport = { parameters: ReportExecutionInput["parameters"]; queries: BuiltReportQuery[] };
export type { ReportQueryDependencies, BuiltReportQuery, BuiltReport };
