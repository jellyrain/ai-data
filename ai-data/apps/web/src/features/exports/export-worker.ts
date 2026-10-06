import type { ExportJob } from "./export-types";
/** 每个导出任务独占 Worker，取消及完成后由主线程终止并释放字体和压缩内存。 */
self.onmessage = async (event: MessageEvent<ExportJob>) => {
  const stage = (value: string) => self.postMessage({ stage: value });
  try {
    const job = event.data;
    stage("正在加载文件生成器");
    const generate =
      job.format === "xlsx"
        ? (await import("./spreadsheet")).generateSpreadsheet
        : job.format === "docx"
          ? (await import("./word")).generateWord
          : (await import("./pdf")).generatePdf;
    const buffer = await generate(job, stage);
    self.postMessage({ buffer }, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "文件生成失败" });
  }
};
