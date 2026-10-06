import type { ExportJob, ExportWorkerMessage } from "./export-types";
/** 主线程仅处理图形，完整数据写入和文件压缩交由可终止的 Worker。 */
async function generateExport(
  input: ExportJob,
  signal: AbortSignal,
  stage: (value: string) => void,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const job =
    input.format === "xlsx"
      ? input
      : await (await import("./export-graphics")).prepareGraphics(input, signal, stage);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./export-worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("导出已取消", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<ExportWorkerMessage>) => {
      if ("stage" in event.data) stage(event.data.stage);
      else if ("error" in event.data) {
        cleanup();
        reject(new Error(event.data.error));
      } else {
        cleanup();
        resolve(event.data.buffer);
      }
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("文件生成器运行失败，请重新生成"));
    };
    try {
      worker.postMessage(job);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
export { generateExport };
