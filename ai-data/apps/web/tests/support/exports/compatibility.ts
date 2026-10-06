import type { CompatibilityRequest, CompatibilityResponse } from "./compatibility-types";

/** 每次样例单独创建 Worker，确保实例关闭及二进制传输可用。 */
function generateCompatibility(request: CompatibilityRequest): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./compatibility-worker.ts", import.meta.url), {
      type: "module",
    });
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("文件生成超过 60 秒"));
    }, 60_000);
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<CompatibilityResponse>) => {
      finish();
      if ("error" in event.data) reject(new Error(event.data.error));
      else resolve(Array.from(new Uint8Array(event.data.buffer)));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message));
    };
    worker.postMessage(request);
  });
}

Object.assign(window, { generateCompatibility });
