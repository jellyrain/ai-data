import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import type { CodexAppServerOptions, CodexCommand, CodexMessage } from "./codex-app-server-types";

/** 官方协议外层字段固定，具体方法的输入输出由调用方校验消费的字段。 */
const messageSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
    /** 官方通知可带发送时间，用于协议遥测；业务时间仍由 API 生成。 */
    emittedAtMs: z.number().optional(),
  })
  .strict();

/** 从项目依赖定位官方平台运行时，直接管理该进程的退出和取消。 */
function resolveCodexCommand(): CodexCommand {
  const localRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const packagePath = localRequire.resolve("@openai/codex/package.json");
  const packageRequire = createRequire(packagePath);
  const architecture =
    process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : undefined;
  const suffix = { win32: "pc-windows-msvc", linux: "unknown-linux-musl", darwin: "apple-darwin" }[
    process.platform as "win32" | "linux" | "darwin"
  ];
  if (!architecture || !suffix)
    throw new ApplicationError("INVALID_INPUT", "当前平台不支持项目 Codex 运行时");
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  let vendor = join(dirname(packagePath), "vendor");
  try {
    vendor = join(dirname(packageRequire.resolve(`${platformPackage}/package.json`)), "vendor");
  } catch {
    /* 同时兼容官方包内直接提供 vendor 的发行结构。 */
  }
  const executable = join(
    vendor,
    `${architecture}-${suffix}`,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (!existsSync(executable))
    throw new ApplicationError("INVALID_INPUT", "项目 Codex 平台运行时未安装完整");
  return { executable, args: ["app-server"] };
}

/** 负责官方 app-server 的 stdio 通信；模型与工具循环由官方进程执行。 */
class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private sequence = 0;
  private closing = false;
  private stopped = false;
  private failed = false;
  constructor(private readonly options: CodexAppServerOptions) {
    this.process = spawn(options.command.executable, options.command.args, {
      env: options.env,
      cwd: options.cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    const lines = createInterface({ input: this.process.stdout });
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.fail());
    this.process.on("error", () => this.fail());
    this.exited = new Promise((resolve) =>
      this.process.once("close", () => {
        this.stopped = true;
        lines.close();
        this.fail();
        resolve();
      }),
    );
    lines.on("line", (line) => {
      try {
        this.receive(messageSchema.parse(JSON.parse(line)));
      } catch {
        this.fail();
      }
    });
  }
  private fail() {
    if (this.failed) return;
    this.failed = true;
    const error = new ApplicationError("INTERNAL_ERROR", "Codex 运行时通信中断");
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.options.onFailure(error);
  }
  private send(message: CodexMessage): void {
    if (!this.stopped && !this.process.stdin.destroyed)
      this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  private receive(message: CodexMessage) {
    if (message.method) {
      if (message.id !== undefined) {
        void this.options.onRequest(message.method, message.params).then(
          (result) => this.send({ id: message.id, result }),
          () => {
            this.send({ id: message.id, error: { code: -32603, message: "工具执行已停止" } });
          },
        );
      } else this.options.onNotification(message.method, message.params);
    } else if (typeof message.id === "number") {
      const value = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (value) clearTimeout(value.timer);
      if (message.error)
        value?.reject(new ApplicationError("INTERNAL_ERROR", "Codex 请求未能完成"));
      else value?.resolve(message.result);
    }
  }
  request(method: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
    if (this.closing || this.stopped || this.failed)
      return Promise.reject(new ApplicationError("CANCELLED", "Codex 运行时已停止"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApplicationError("QUERY_TIMEOUT", "Codex 协议请求超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string): void {
    this.send({ method });
  }
  /** 先关闭输入等待官方进程退出，到时仍未退出则终止已持有的那个进程。 */
  async close(): Promise<void> {
    this.closing = true;
    this.fail();
    this.process.stdin.end();
    const timer = setTimeout(() => {
      if (!this.stopped) this.process.kill();
    }, 1500);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
export { CodexAppServer, resolveCodexCommand };
