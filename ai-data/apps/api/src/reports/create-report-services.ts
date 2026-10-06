import {
  savedReportSchema,
  reportDefinitionVersionSchema,
  type SavedReport,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { ApiQueryAuthorization } from "../app-types";
import type { BusinessCatalogService } from "../catalog/business-catalog-service";
import type { MetricService } from "../metrics/metric-service";
import type { MemoryAccess } from "../memory/memory-access";
import type { ConversationService } from "../conversations/conversation-service";
import { assertEvidenceAccess } from "../evidence/evidence-access";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { ReportQueryService } from "./report-query-service";
import { ReportDefinitionService } from "./report-definition-service";
import { SqlReportDefinitionRepository } from "./sql-report-definition-repository";
import { ReportTemplateService } from "./report-template-service";
import { ReportExecutionService } from "./report-execution-service";
import { SqlReportExecutionRepository } from "./sql-report-execution-repository";
import { ReportRevisionService } from "./report-revision-service";
import { SqlReportRevisionRepository } from "./sql-report-revision-repository";
import { ReportService } from "./report-service";
import { SqlReportRepository } from "./sql-report-repository";
import { ReportManagementService } from "./report-management-service";
import { SqlReportManagementRepository } from "./sql-report-management-repository";
import { ReportSharingService } from "./report-sharing-service";
import { SqlReportSharingRepository } from "./sql-report-sharing-repository";

/** 统一装配定义、查询、执行及编辑，事务校验复用同一连接的目录与权限服务。 */
function createReportServices(dependencies: {
  database: MetadataTransactionalExecutor;
  runs: AnalysisRunService;
  catalog: BusinessCatalogService;
  authorization: ApiQueryAuthorization;
  metrics: MetricService;
  catalogForExecutor(executor: MetadataQueryExecutor): BusinessCatalogService;
  authorizationForExecutor(executor: MetadataQueryExecutor): ApiQueryAuthorization;
  metricsForExecutor(executor: MetadataQueryExecutor): MetricService;
  access: Pick<MemoryAccess, "scope">;
  conversations: Pick<ConversationService, "get">;
  refreshContext(context: AuthContext): Promise<AuthContext>;
  selectAgent?(
    context: AuthContext,
    id?: string,
  ): Promise<{ agentId: string; agentVersion: number }>;
  wake?(): void;
}) {
  const repository = new SqlReportDefinitionRepository(dependencies.database);
  const builder = new ReportQueryService({
    catalog: dependencies.catalog,
    authorization: dependencies.authorization,
    metrics: dependencies.metrics,
    forExecutor: (executor) => ({
      catalog: dependencies.catalogForExecutor(executor),
      authorization: dependencies.authorizationForExecutor(executor),
      metrics: dependencies.metricsForExecutor(executor),
    }),
  });
  const templates = new ReportTemplateService({
    database: dependencies.database,
    repository,
    builder,
    authorizeScope: (context, scope, executor) =>
      dependencies.access.scope(context, scope, executor),
  });
  const definitions = new ReportDefinitionService({
    repository,
    validateDefinition: builder.validate.bind(builder),
    authorizeEvidence: (context, evidence, executor) =>
      assertEvidenceAccess(
        evidence,
        context,
        executor ? dependencies.authorizationForExecutor(executor) : dependencies.authorization,
      ),
    listPublished: templates.list.bind(templates),
  });
  const revisionRepository = new SqlReportRevisionRepository(dependencies.database);
  const executions = new ReportExecutionService({
    repository: new SqlReportExecutionRepository(dependencies.database),
    definitions,
    builder,
    runs: dependencies.runs,
    refreshContext: dependencies.refreshContext,
    narratives: revisionRepository.narratives.bind(revisionRepository),
    authorizeEvidence: (context, evidence, executor) =>
      assertEvidenceAccess(
        evidence,
        context,
        executor ? dependencies.authorizationForExecutor(executor) : dependencies.authorization,
      ),
  });
  const revisions = new ReportRevisionService({
    repository: revisionRepository,
    definitions,
    executions,
    validate: builder.validate.bind(builder),
    runs: dependencies.runs,
    selectAgent: dependencies.selectAgent,
    wake: dependencies.wake,
  });
  const saveSnapshotDefinition = async (
    context: AuthContext,
    snapshot: SavedReport,
    executor: MetadataQueryExecutor,
    isCompleted: boolean,
  ) => {
    const existing = await repository.find(
      "report",
      context.organizationId,
      snapshot.report_id,
      undefined,
      executor,
    );
    const definition = await builder.fromSnapshot(context, snapshot, executor);
    await definitions.save(
      context,
      {
        definition,
        shared_with: existing?.shared_with ?? snapshot.shared_with,
        ...(isCompleted ? { source_analysis_run_id: snapshot.analysis_run_id } : {}),
      },
      snapshot.report_id,
      existing?.version ?? 0,
      executor,
    );
  };
  const reports = new ReportService(
    new SqlReportRepository(dependencies.database),
    dependencies.runs,
    dependencies.authorization,
    {
      source: repository.source.bind(repository),
      assertActiveUsers: repository.assertActiveUsers.bind(repository),
      findDefinitionHead: async (context, id) => {
        const found = await repository.find("report", context.organizationId, id);
        return found ? reportDefinitionVersionSchema.parse(found) : null;
      },
      onSaved: (context, snapshot, executor) =>
        saveSnapshotDefinition(context, snapshot, executor, true),
    },
  );
  const management = new ReportManagementService({
    repository: new SqlReportManagementRepository(dependencies.database),
    reports,
    definitions,
    source: repository.source.bind(repository),
    runs: dependencies.runs,
    conversations: dependencies.conversations,
  });
  const complete = async (
    context: AuthContext,
    runId: string,
    executor: MetadataQueryExecutor,
    content: string,
  ) => {
    await revisions.complete(context, runId, executor, content);
    const result = await executor.execute({
      sql: "SELECT r.report_json FROM dbo.saved_reports r WHERE r.organization_id=@org AND r.user_id=@user AND JSON_VALUE(r.report_json,'$.analysis_run_id')=@run AND NOT EXISTS(SELECT 1 FROM dbo.report_templates t WHERE t.organization_id=r.organization_id AND t.report_id=r.report_id)",
      parameters: [
        { name: "org", type: "string", value: context.organizationId },
        { name: "user", type: "string", value: context.userId },
        { name: "run", type: "string", value: runId },
      ],
    });
    for (const row of result.rows)
      await saveSnapshotDefinition(
        context,
        parseStoredRecord(() => savedReportSchema.parse(JSON.parse(String(row.report_json)))),
        executor,
        false,
      );
  };
  const sharing = new ReportSharingService({
    definitions,
    reports,
    repository: new SqlReportSharingRepository(dependencies.database),
  });
  return {
    builder,
    templates,
    definitions,
    executions,
    revisions,
    reports,
    management,
    sharing,
    complete,
  };
}
export { createReportServices };
