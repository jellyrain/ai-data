import type { ReportSharing, ReportShareCandidate, ReportShareMember } from "@ai-data/contracts";
import type { ReportDependencies } from "./report-workspace-types";
/** 草稿和最新远端范围分别保存，冲突时由作者确认合并。 */
type SharingState = {
  reportId: string;
  baseline: ReportSharing | null;
  conflict: ReportSharing | null;
  selected: ReportShareMember[];
  candidates: ReportShareCandidate[];
  nextCursor?: string;
  loading: boolean;
  searching: boolean;
  saving: boolean;
  uncertain: boolean;
  saved: boolean;
  error: string;
};
/** 保存核对成功后刷新版本历史，保留页面正在查看的结果。 */
type SharingDependencies = ReportDependencies & { changed: () => void | Promise<void> };
export type { SharingState, SharingDependencies };
