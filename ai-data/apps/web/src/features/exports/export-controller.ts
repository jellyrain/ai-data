import { shallowReactive } from "vue";
import dayjs from "dayjs";
import { ApiError } from "../../shared/http/api-error";
import {
  checkExportBudget,
  exportDocument,
  safeFileName,
  selectExportTables,
  sourcePath,
} from "./export-model";
import type { ExportDependencies, ExportState } from "./export-controller-types";
import type { ExportSource, ExportJob } from "./export-types";
const mime = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};
function initial(): ExportState {
  return { source: null, document: null, busy: false, ready: false, stage: "", error: "" };
}
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** 生成、下载各自复核当前身份与固定内容；取消会同时终止生成 Worker。 */
class ExportController {
  readonly state = shallowReactive<ExportState>(initial());
  private controller = new AbortController();
  private generation = 0;
  private unregister: () => void;
  private file?: { buffer: ArrayBuffer; hash: string; name: string; format: ExportJob["format"] };
  private url?: string;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private dependencies: ExportDependencies) {
    this.unregister = dependencies.resources.register(() => this.leave());
  }
  private clearFile() {
    this.file = undefined;
    this.state.ready = false;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    clearTimeout(this.timer);
  }
  cancel() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.clearFile();
    this.state.busy = false;
    this.state.stage = "已取消，可重新生成";
  }
  leave() {
    this.cancel();
    Object.assign(this.state, initial());
  }
  dispose() {
    this.leave();
    this.unregister();
  }
  private current(generation: number) {
    return generation === this.generation && !this.controller.signal.aborted;
  }
  private failure(error: unknown) {
    this.clearFile();
    if (error instanceof ApiError && [401, 403].includes(error.status)) this.leave();
    this.state.error =
      error instanceof Error && error.name !== "ZodError"
        ? error.message
        : "导出内容格式不符合合同";
  }
  private async read(source: ExportSource) {
    const identity = this.dependencies.identity();
    if (!identity) throw new ApiError("请登录后导出", 401);
    const key = JSON.stringify(identity);
    const pack = await this.dependencies.request(sourcePath(source), {
      signal: this.controller.signal,
    });
    if (key !== JSON.stringify(this.dependencies.identity()))
      throw new ApiError("账号已变化，请重新打开导出", 401);
    return {
      document: exportDocument(pack, source, identity.organizationId),
      hash: await digest(pack),
    };
  }
  async open(source: ExportSource) {
    this.leave();
    this.state.source = structuredClone(source);
    this.state.busy = true;
    this.state.stage = "正在读取已保存内容";
    const generation = this.generation;
    try {
      const result = await this.read(source);
      if (this.current(generation)) {
        this.state.document = result.document;
        this.state.stage = "请选择文件内容";
      }
    } catch (error) {
      if (this.current(generation)) this.failure(error);
    } finally {
      if (this.current(generation)) this.state.busy = false;
    }
  }
  async generate(format: ExportJob["format"], tableIds: string[], summaryRows: 50 | 100 | 200) {
    if (this.state.busy || !this.state.source) return;
    this.clearFile();
    this.state.error = "";
    this.state.busy = true;
    this.state.stage = "正在复核来源与权限";
    const generation = this.generation,
      source = this.state.source;
    try {
      const { document, hash } = await this.read(source);
      if (!this.current(generation)) return;
      this.state.document = document;
      const tables = selectExportTables(document, tableIds);
      checkExportBudget(tables, document.blocks);
      if (format === "xlsx" && !tables.length) throw new Error("请选择至少一张完整数据表");
      if (
        format !== "xlsx" &&
        tables.reduce((sum, t) => sum + Math.min(summaryRows, t.result.rows.length), 0) > 2000
      )
        throw new Error("文档摘要总量最多 2,000 行，请减少表格或每表行数");
      const job: ExportJob = {
        format,
        document: {
          ...document,
          tables,
          metadata: [
            ...document.metadata,
            ...document.tables
              .filter((table) => !tableIds.includes(table.id))
              .map((table) => `${table.title}：未选入本次文件`),
          ],
        },
        tableIds: tables.map((t) => t.id),
        summaryRows,
        fontBase: new URL(`${import.meta.env.BASE_URL}fonts/noto-sans-sc/`, location.origin).href,
      };
      const generate =
        this.dependencies.generate ?? (await import("./export-runtime")).generateExport;
      if (!this.current(generation)) return;
      const buffer = await generate(job, this.controller.signal, (stage) => {
        if (this.current(generation)) this.state.stage = stage;
      });
      if (!this.current(generation)) return;
      this.file = {
        buffer,
        hash,
        format,
        name: `${safeFileName(document.title)}_${dayjs().tz("Asia/Shanghai").format("YYYYMMDD_HHmmss")}.${format}`,
      };
      this.state.ready = true;
      this.state.stage = "文件已生成，下载时将再次核对权限";
    } catch (error) {
      if (this.current(generation)) this.failure(error);
    } finally {
      if (this.current(generation)) this.state.busy = false;
    }
  }
  async download() {
    const file = this.file,
      source = this.state.source;
    if (!file || !source || this.state.busy) return;
    this.state.busy = true;
    this.state.error = "";
    this.state.stage = "正在核对下载权限";
    const generation = this.generation;
    try {
      const current = await this.read(source);
      if (!this.current(generation)) return;
      if (current.hash !== file.hash) {
        this.state.document = current.document;
        throw new Error("保存内容已变化，请重新生成文件");
      }
      if (this.dependencies.download)
        this.dependencies.download(file.buffer, file.name, mime[file.format]);
      else {
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(new Blob([file.buffer], { type: mime[file.format] }));
        const anchor = document.createElement("a");
        anchor.href = this.url;
        anchor.download = file.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        const url = this.url;
        this.timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          if (this.url === url) this.url = undefined;
        }, 10000);
      }
      this.state.stage = "已发起下载";
    } catch (error) {
      if (this.current(generation)) this.failure(error);
    } finally {
      if (this.current(generation)) this.state.busy = false;
    }
  }
}
export { ExportController };
