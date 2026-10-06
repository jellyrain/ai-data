import type {
  ReportDefinitionVersion,
  ReportExecution,
  ReportSummary,
  ReportVersionList,
  SavedReport,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
import type { SessionResources } from "../../../shared/session/session-resources";
/** 页面独立持有待运行定义和已经显示的成功结果。 */
type ReportState = {
  reportId: string;
  items: ReportSummary[];
  nextCursor?: string;
  listing: boolean;
  listError: string;
  loading: boolean;
  versions: ReportVersionList;
  definition: ReportDefinitionVersion | null;
  snapshot: SavedReport | null;
  execution: ReportExecution | null;
  displayExecution: ReportExecution | null;
  definitionError: string;
  resultError: string;
  historyError: string;
  executionError: string;
  sending: boolean;
  refreshing: boolean;
  selecting: boolean;
  uncertain: boolean;
};
/** 请求已包含认证，页面补充自身的取消与响应归属检查。 */
type ReportDependencies = {
  request: Transport;
  resources: SessionResources;
  identity: () => { userId: string; organizationId: string } | null;
};
export type { ReportState, ReportDependencies };
