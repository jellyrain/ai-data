import type { AnalysisRunStatus } from "@ai-data/contracts";

/** 分析运行记录可保存的状态值；状态转换规则由运行流程负责。 */

/** 一次用户问题对应的分析运行记录。 */
type AnalysisRun = {
  /** 分析运行主键。 */
  id: string;
  /** 所属会话。 */
  conversationId: string;
  /** 所属组织。 */
  organizationId: string;
  /** 发起用户。 */
  userId: string;
  /** 当前运行状态。 */
  status: AnalysisRunStatus;
  /** 稳定失败码。 */
  errorCode: string | null;
  /** 面向用户的失败说明。 */
  errorMessage: string | null;
  /** 首次更新为 running 的时间；尚未启动时为 null。 */
  startedAt: Date | null;
  /** 更新为终态时记录的时间；尚未结束时为 null。 */
  completedAt: Date | null;
  /** 创建时间。 */
  createdAt: Date;
};

export type { AnalysisRun, AnalysisRunStatus };
