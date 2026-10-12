/** 统一 JSON 传输选项；认证信息由调用边界装配。 */
type TransportOptions = {
  method?: string;
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 文件请求使用原始 Blob；响应仍默认校验 JSON。 */
  binaryBody?: Blob;
  /** 受权图片读取返回 Blob，错误仍沿用统一 JSON 合同。 */
  responseType?: "blob";
};
/** HTTP 边界返回待校验的数据。 */
type Transport = (path: string, options?: TransportOptions) => Promise<unknown>;

export type { Transport, TransportOptions };
