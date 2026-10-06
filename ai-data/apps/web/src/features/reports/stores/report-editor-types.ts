import type {
  ReportDefinition,
  ReportDefinitionVersion,
  Dataset,
  MetricDefinition,
  RelationGraph,
  AgentVersion,
} from "@ai-data/contracts";
/** 编辑基准、未保存草稿及冲突版本独立存放，目录只用于当前身份。 */
type ReportEditorState = {
  reportId: string;
  baseline: ReportDefinitionVersion | null;
  latest: ReportDefinitionVersion | null;
  draft: ReportDefinition;
  loading: boolean;
  saving: boolean;
  ready: boolean;
  locked: boolean;
  uncertain: boolean;
  error: string;
  notice: string;
  issues: string[];
  sources: { source_id: string }[];
  sourceCursor?: string;
  loadingSources: boolean;
  datasets: Record<string, Dataset[]>;
  relations: Record<string, RelationGraph>;
  metrics: MetricDefinition[];
  agents: AgentVersion[];
  catalogError: string;
};
export type { ReportEditorState };
