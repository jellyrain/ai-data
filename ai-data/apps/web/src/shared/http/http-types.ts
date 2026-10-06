/** 统一 JSON 传输选项；认证信息由调用边界装配。 */
type TransportOptions = {
  method?: string;
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};
/** HTTP 边界返回待校验的数据。 */
type Transport = (path: string, options?: TransportOptions) => Promise<unknown>;

export type { Transport, TransportOptions };
