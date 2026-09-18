/** 项目运行时或测试子进程的启动入口，参数通过 spawn 数组传递。 */
type CodexCommand = { executable: string; args: string[] };
/** app-server 双向 JSON-RPC 的已解析消息。 */
type CodexMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
/** 子进程通信的请求和通知处理入口。 */
type CodexAppServerOptions = {
  command: CodexCommand;
  env: NodeJS.ProcessEnv;
  cwd: string;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onFailure: (error: Error) => void;
};
export type { CodexCommand, CodexMessage, CodexAppServerOptions };
