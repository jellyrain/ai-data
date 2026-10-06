import type { SessionResources } from "../../shared/session/session-resources";
import type { Transport } from "../../shared/http/http-types";
import type { ExportDocument, ExportJob, ExportSource } from "./export-types";
/** 状态只保存一项任务；文件缓冲不进入 Vue 深层响应。 */
type ExportState = {
  source: ExportSource | null;
  document: ExportDocument | null;
  busy: boolean;
  ready: boolean;
  stage: string;
  error: string;
};
/** 生成与下载适配器可在验收中注入，生产实现使用模块 Worker 和浏览器下载。 */
type ExportDependencies = {
  request: Transport;
  resources: SessionResources;
  identity: () => { userId: string; organizationId: string } | null;
  generate?: (
    job: ExportJob,
    signal: AbortSignal,
    stage: (value: string) => void,
  ) => Promise<ArrayBuffer>;
  download?: (buffer: ArrayBuffer, name: string, mime: string) => void;
};
export type { ExportState, ExportDependencies };
