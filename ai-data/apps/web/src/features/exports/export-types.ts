import type {
  QueryResult,
  ReportExportContent,
  ReportExecutionExportContent,
  ConversationExportContent,
} from "@ai-data/contracts";
import type MarkdownIt from "markdown-it";
/** 从已安装解析器公开方法推导词法节点，避免依赖私有入口。 */
type MarkdownToken = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];
/** 页面选定的不可变来源；快照版本与定义版本分开处理。 */
type ExportSource =
  | { kind: "execution"; id: string; reportId: string }
  | { kind: "snapshot"; id: string; version: number }
  | { kind: "conversation"; id: string; evidenceId?: string };
/** 已通过 API 授权的三种内容包。 */
type ExportPack = ReportExportContent | ReportExecutionExportContent | ConversationExportContent;
/** 文档内联文字，只接受安全链接和基本文字样式。 */
type DocumentRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
};
/** 文件生成器共享的纯数据块，图片由主线程受控渲染后传入。 */
type DocumentBlock =
  | { kind: "heading"; level: number; runs: DocumentRun[] }
  | { kind: "paragraph"; runs: DocumentRun[]; bullet?: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "diagram"; source: string }
  | {
      kind: "chart";
      tableId: string;
      title: string;
      chart: { type: "bar" | "line" | "pie"; x: string; y: string };
    }
  | { kind: "image"; data: string; width: number; height: number; caption: string };
/** 每张来源只导出一次；完整性来自合同，不根据 DOM 推断。 */
type ExportTable = {
  id: string;
  title: string;
  complete: boolean;
  createdAt: string;
  result: QueryResult;
};
/** 固定内容包转换出的文件内容，表格与正文可独立选择。 */
type ExportDocument = {
  title: string;
  metadata: string[];
  tables: ExportTable[];
  blocks: DocumentBlock[];
};
/** 字体由 PDF Worker 按需读取，摘要行数为每表上限。 */
type ExportJob = {
  format: "xlsx" | "docx" | "pdf";
  document: ExportDocument;
  tableIds: string[];
  summaryRows: 50 | 100 | 200;
  fontBase: string;
};
/** Worker 只发送真实阶段和生成结果，不估算虚假完成百分比。 */
type ExportWorkerMessage = { stage: string } | { buffer: ArrayBuffer } | { error: string };
export type {
  MarkdownToken,
  ExportSource,
  ExportPack,
  DocumentRun,
  DocumentBlock,
  ExportTable,
  ExportDocument,
  ExportJob,
  ExportWorkerMessage,
};
