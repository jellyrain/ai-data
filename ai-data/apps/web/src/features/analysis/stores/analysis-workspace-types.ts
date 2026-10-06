import type {
  AgentVersion,
  AnalysisRunState,
  AnalysisStep,
  QueryEvidence,
  SseEvent,
} from "@ai-data/contracts";
import type { Conversation, ConversationDetail } from "../api/analysis-types";
import type { SessionResources } from "../../../shared/session/session-resources";
import type { Transport } from "../../../shared/http/http-types";

/** 当前页面重建的一次运行；证据数组用浅层响应状态持有。 */
type RunView = {
  id: string;
  snapshot: AnalysisRunState | null;
  cursor: number;
  events: SseEvent[];
  connection: string;
  error: string;
  evidence: QueryEvidence[];
  steps: AnalysisStep[];
  evidenceLoaded: boolean;
  evidenceLoading: boolean;
  evidenceError: string;
};
/** 应用实例独有的工作台状态；身份切换时全部清除。 */
type WorkspaceState = {
  conversations: Conversation[];
  agents: AgentVersion[];
  detail: ConversationDetail | null;
  boundAgent: AgentVersion | null;
  runs: Record<string, RunView>;
  draft: string;
  loading: boolean;
  sending: boolean;
  creating: boolean;
  answering: boolean;
  cancelling: boolean;
  pendingMessage: boolean;
  creationUncertain: boolean;
  error: string;
  listError: string;
};
/** 只通过同源认证服务访问 API，测试可注入隔离响应。 */
type WorkspaceDependencies = {
  request: Transport;
  stream: (path: string, cursor: number, signal: AbortSignal) => Promise<Response>;
  resources: SessionResources;
  identity: () => { userId: string; organizationId: string } | null;
};
/** 不确定的写入保留原内容与键，重试不能生成第二轮。 */
type PendingMessage = { content: string; key: string };
export type { RunView, WorkspaceState, WorkspaceDependencies, PendingMessage };
