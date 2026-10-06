import type { QueryClient } from "@tanstack/vue-query";
import type { AuthSession } from "../features/auth/stores/auth-session";
import type { ThemeController } from "../shared/theme/theme";
import type { TransportOptions } from "../shared/http/http-types";
import type { SessionResources } from "../shared/session/session-resources";
import type { AnalysisWorkspace } from "../features/analysis/stores/analysis-workspace";
import type { ReportWorkspace } from "../features/reports/stores/report-workspace";
import type { ReportNarratives } from "../features/reports/stores/report-narratives";
import type { ReportEditor } from "../features/reports/stores/report-editor";
import type { ReportRevisions } from "../features/reports/stores/report-revisions";
import type { ReportSharingController } from "../features/reports/stores/report-sharing";
/** 应用级服务通过注入使用，测试可提供隔离实例。 */
type AppServices = {
  auth: AuthSession;
  theme: ThemeController;
  query: QueryClient;
  resources: SessionResources;
  analysis: AnalysisWorkspace;
  reports: ReportWorkspace;
  reportNarratives: ReportNarratives;
  reportEditor: ReportEditor;
  reportRevisions: ReportRevisions;
  reportSharing: ReportSharingController;
  request: (path: string, options?: TransportOptions) => Promise<unknown>;
  dispose: () => void;
};
export type { AppServices };
