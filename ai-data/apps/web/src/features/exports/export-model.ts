import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  reportExportContentSchema,
  reportExecutionExportContentSchema,
  conversationExportContentSchema,
} from "@ai-data/contracts";
import type { QueryEvidence, SavedReport } from "@ai-data/contracts";
import type {
  ExportDocument,
  ExportTable,
  DocumentBlock,
  ExportSource,
  ExportPack,
} from "./export-types";
import { markdownDocument } from "./markdown-document";
dayjs.extend(utc);
dayjs.extend(timezone);
/** 保存所有层级的筛选和调用参数，包含授权后的对象过滤及预聚合过滤。 */
function queryConditions(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const result: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const location = path ? `${path}.${key}` : key;
    if (
      ["filters", "on_filters", "having"].includes(key) &&
      child &&
      typeof child === "object" &&
      "items" in child &&
      Array.isArray(child.items)
    ) {
      if (child.items.length) result.push(`${location} ${JSON.stringify(child)}`);
    } else if (key === "parameters" && Array.isArray(child)) {
      if (child.length) result.push(`parameters ${JSON.stringify(child)}`);
    } else result.push(...queryConditions(child, location));
  }
  return result;
}
function filenameCharacters(value: string): string {
  return Array.from(value, (character) => (character.charCodeAt(0) < 32 ? "_" : character)).join(
    "",
  );
}
/** Windows 与浏览器均接受的文件名，保留用户能识别的标题。 */
function safeFileName(value: string): string {
  const safe = filenameCharacters(value)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 100);
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)
    ? `报表_${safe}`
    : safe;
}
/** 工作表名最大 31 字符，导出说明占用固定名称；大小写也视为冲突。 */
function sheetNames(titles: string[]): string[] {
  const used = new Set(["导出说明"]);
  return titles.map((title) => {
    const stem = (
      filenameCharacters(title)
        .replace(/[[\]:*?/\\]/g, "_")
        .replace(/^'+|'+$/g, "") || "数据"
    ).slice(0, 31);
    let name = stem,
      index = 1;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${index++})`;
      name = stem.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}
/** 本地生成资源预算独立于 API 的单次查询上限。 */
function checkExportBudget(tables: ExportTable[], blocks: DocumentBlock[]): void {
  if (tables.length > 100) throw new Error("一次最多导出 100 张表，请减少选择");
  if (tables.reduce((total, table) => total + table.result.rows.length, 0) > 100000)
    throw new Error("一次最多导出 100,000 行，请减少选择");
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(tables.map((t) => t.result))).byteLength > 32 * 1024 * 1024)
    throw new Error("选定表格超过 32 MiB，请减少选择");
  if (encoder.encode(JSON.stringify(blocks)).byteLength > 2 * 1024 * 1024)
    throw new Error("正文超过 2 MiB，请缩小导出范围");
}
function selectExportTables(document: ExportDocument, ids: string[]) {
  return document.tables.filter((table) => table.complete && ids.includes(table.id));
}
function sourcePath(source: ExportSource): string {
  const id = encodeURIComponent(source.id);
  return source.kind === "execution"
    ? `/api/report-executions/${id}/export-content`
    : source.kind === "snapshot"
      ? `/api/reports/${id}/export-content?version=${source.version}`
      : `/api/conversations/${id}/export-content`;
}
/** 转换时核对固定来源和组织，外层会在下载前重新读取授权包。 */
function exportDocument(
  input: unknown,
  source: ExportSource,
  organizationId: string,
): ExportDocument {
  const pack: ExportPack =
    source.kind === "execution"
      ? reportExecutionExportContentSchema.parse(input)
      : source.kind === "snapshot"
        ? reportExportContentSchema.parse(input)
        : conversationExportContentSchema.parse(input);
  const document: ExportDocument = { title: "", metadata: [], tables: [], blocks: [] };
  const tables = new Map<string, ExportTable>();
  function add(evidence: QueryEvidence, title: string) {
    if (evidence.organization_id !== organizationId) throw new Error("导出证据组织不匹配");
    const existing = tables.get(evidence.evidence_id);
    if (existing) {
      if (JSON.stringify(existing.result) !== JSON.stringify(evidence.result))
        throw new Error("同一来源内容不一致");
      return;
    }
    tables.set(evidence.evidence_id, {
      id: evidence.evidence_id,
      title,
      complete: !evidence.result.truncated,
      createdAt: evidence.created_at,
      result: evidence.result,
    });
    document.metadata.push(
      ...queryConditions(evidence.authorized_query).map(
        (condition) => `${title} · 查询筛选 ${condition}`,
      ),
    );
  }
  function snapshot(report: SavedReport) {
    if (report.organization_id !== organizationId) throw new Error("报表组织不匹配");
    document.metadata.push(
      `报表 ${report.report_id} · 快照 v${report.version} · ${report.created_at}`,
    );
    for (const section of report.sections) {
      document.blocks.push({ kind: "heading", level: 2, runs: [{ text: section.title }] });
      for (const block of section.blocks) {
        if (block.content) document.blocks.push(...markdownDocument(block.content));
        if (block.type === "chart" && block.chart)
          for (const id of block.evidence_ids)
            document.blocks.push({
              kind: "chart",
              tableId: id,
              title: block.title,
              chart: block.chart,
            });
      }
    }
  }
  if (pack.kind === "report_execution") {
    const record = pack.execution;
    if (
      source.kind !== "execution" ||
      record.execution_id !== source.id ||
      record.report_id !== source.reportId ||
      record.status !== "completed" ||
      record.organization_id !== organizationId
    )
      throw new Error("导出执行来源不匹配或尚未完成");
    document.title = record.definition.title;
    document.metadata.push(
      `执行 ${record.execution_id} · 定义 v${record.definition_version}`,
      Object.keys(record.parameters).length
        ? `实际条件 ${JSON.stringify(record.parameters)}`
        : "固定查询条件见来源筛选记录",
      `完成时间 ${record.completed_at ?? record.created_at}`,
    );
    snapshot(record.snapshot!);
    for (const query of record.definition.queries) {
      const item = record.results.find((result) => result.query_id === query.query_id)!;
      add(
        item.evidence,
        record.definition.presentation
          .flatMap((s) => s.blocks)
          .find((b) => b.type === "table" && b.query_ids.includes(item.query_id))?.title ??
          item.query_id,
      );
    }
    // 快照可能沿用旧展示内容；图表及正文优先采用该次执行固定的定义。
    document.blocks = [];
    for (const section of record.definition.presentation) {
      document.blocks.push({ kind: "heading", level: 2, runs: [{ text: section.title }] });
      for (const block of section.blocks) {
        if (block.content) document.blocks.push(...markdownDocument(block.content));
        if (block.type === "chart" && block.chart)
          for (const id of block.query_ids) {
            const tableId = record.results.find((r) => r.query_id === id)?.evidence.evidence_id;
            if (tableId)
              document.blocks.push({
                kind: "chart",
                tableId,
                title: block.title,
                chart: block.chart,
              });
          }
      }
    }
    for (const narrative of pack.narratives) {
      if (narrative.execution_id !== source.id) throw new Error("分析说明执行归属不匹配");
      document.blocks.push(
        { kind: "heading", level: 2, runs: [{ text: `分析说明 · ${narrative.created_at}` }] },
        ...markdownDocument(narrative.content),
      );
    }
  } else if (pack.kind === "report") {
    if (
      source.kind !== "snapshot" ||
      pack.report.report_id !== source.id ||
      pack.report.version !== source.version
    )
      throw new Error("导出快照版本不匹配");
    document.title = pack.report.title;
    snapshot(pack.report);
    for (const item of pack.tables)
      add(
        item.evidence,
        pack.report.sections
          .flatMap((s) => s.blocks)
          .find((b) => b.type === "table" && b.evidence_ids.includes(item.evidence.evidence_id))
          ?.title ?? `来源 ${item.evidence.evidence_id}`,
      );
  } else {
    if (source.kind !== "conversation" || pack.conversation_id !== source.id)
      throw new Error("导出会话不匹配");
    if (pack.runs.some((run) => !["completed", "failed", "cancelled"].includes(run.status)))
      throw new Error("请等待当前运行结束或取消后再导出");
    document.title = pack.title ?? "分析会话";
    document.metadata.push(
      `会话 ${pack.conversation_id}`,
      ...pack.runs.map((run) => `运行 ${run.analysis_run_id} · ${run.status}`),
    );
    for (const message of [...pack.messages].sort((a, b) => a.sequence - b.sequence)) {
      document.blocks.push({
        kind: "heading",
        level: 2,
        runs: [{ text: `${message.role === "user" ? "用户" : "助手"} · ${message.created_at}` }],
      });
      document.blocks.push(
        ...(message.role === "user"
          ? [{ kind: "paragraph" as const, runs: [{ text: message.content }] }]
          : markdownDocument(message.content)),
      );
    }
    for (const artifact of pack.artifacts) snapshot(artifact.report);
    for (const item of pack.tables) {
      if (
        !pack.runs.some(
          (run) =>
            run.analysis_run_id === item.evidence.analysis_run_id && run.status === "completed",
        )
      )
        throw new Error("结果来源运行未完成");
      add(item.evidence, `查询 ${item.evidence.tool_call_id}`);
    }
  }
  document.tables = [...tables.values()];
  document.metadata.push(
    ...document.tables.map(
      (table) =>
        `${table.title} · ${table.id} · ${table.createdAt} · ${table.complete ? `完整 ${table.result.rows.length} 行` : "截断，排除明细"}${table.result.freshness ? ` · ${table.result.freshness}` : ""}`,
    ),
  );
  return document;
}
/** 标准日期列按东八区文本导出；编码及一般字符串保持原样。 */
function exportCell(value: unknown, dataType: string): string | number | boolean | null {
  if (value === null) return null;
  if (dataType === "datetime" && typeof value === "string")
    return /(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? dayjs(value).tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss")
      : value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string")
    return value;
  throw new Error("结果包含不支持的单元格类型");
}
export {
  safeFileName,
  sheetNames,
  checkExportBudget,
  selectExportTables,
  sourcePath,
  exportDocument,
  exportCell,
};
