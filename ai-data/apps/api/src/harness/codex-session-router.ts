import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import type { CodexAppServer } from "./codex-app-server";
import type { HarnessRequest, HarnessResult } from "./harness-types";

/** 每次函数请求必须携带所属线程、轮次和唯一调用标识。 */
const toolCallSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    callId: z.string().min(1),
    tool: z.string().min(1),
    namespace: z.null().optional(),
    arguments: z.unknown(),
  })
  .strict();
const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const identifier = (value: unknown) => z.string().min(1).parse(value);

/** 仅消费已绑定线程的当前轮次；串行提交工具及压缩事件，终态等待先前提交完成。 */
class CodexSessionRouter {
  private resolve!: (result: HarnessResult) => void;
  private reject!: (error: unknown) => void;
  private end!: () => void;
  readonly result = new Promise<HarnessResult>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  readonly completion = new Promise<void>((resolve) => {
    this.end = resolve;
  });
  turnId?: string;
  nativeEnded = false;
  private stopped = false;
  private waiting = false;
  private content = "";
  private queue = Promise.resolve();
  private readonly calls = new Set<string>();
  private readonly compactions = new Set<string>();

  constructor(
    readonly threadId: string,
    private readonly request: HarnessRequest,
  ) {
    // 注册发生在 turn/start 之前，此时调用方仍可能等待协议响应。
    void this.result.catch(() => {});
  }
  bindTurn(id: unknown): void {
    const value = identifier(id);
    if (this.turnId && this.turnId !== value)
      throw new ApplicationError("INTERNAL_ERROR", "Codex 轮次不匹配");
    this.turnId = value;
  }
  fail(error: unknown): void {
    this.stopped = true;
    this.reject(error);
  }
  disconnected(error: Error): void {
    this.nativeEnded = true;
    this.end();
    this.fail(error);
  }
  async call(method: string, params: unknown): Promise<unknown> {
    if (method !== "item/tool/call")
      throw new ApplicationError("INTERNAL_ERROR", "Codex 请求了未开放的交互");
    const call = toolCallSchema.parse(params);
    if (call.threadId !== this.threadId || (this.turnId && call.turnId !== this.turnId))
      throw new ApplicationError("INTERNAL_ERROR", "Codex 工具调用上下文无效");
    try {
      this.bindTurn(call.turnId);
      if (this.stopped || this.waiting) throw new ApplicationError("CANCELLED", "分析已停止");
      if (
        this.calls.has(call.callId) ||
        !this.request.tools.some((tool) => tool.name === call.tool)
      )
        throw new ApplicationError("INTERNAL_ERROR", "Codex 工具调用上下文无效");
      this.calls.add(call.callId);
      const task = this.queue.then(async () => {
        if (this.stopped || this.waiting) throw new ApplicationError("CANCELLED", "分析已停止");
        const result = await this.request.executeTool(call.tool, call.arguments, call.callId);
        if (this.stopped) throw new ApplicationError("CANCELLED", "分析已停止");
        if (result.stop) {
          this.waiting = true;
          // 先发送函数结果，让官方历史记录拥有对应输出，再中断澄清轮次。
          setImmediate(() => this.resolve({ status: "waiting_clarification" }));
        }
        return {
          success: result.success,
          contentItems: [{ type: "inputText", text: JSON.stringify(result.output) ?? "null" }],
        };
      });
      this.queue = task.then(
        () => {},
        () => {},
      );
      return await task;
    } catch (error) {
      const failure = new ApplicationError(
        error instanceof ApplicationError ? error.code : "INTERNAL_ERROR",
        "分析工具执行失败",
      );
      this.fail(failure);
      throw failure;
    }
  }
  notify(method: string, params: unknown): void {
    try {
      const value = record(params);
      if (value.threadId !== this.threadId) return;
      if (method === "turn/started") {
        if (this.turnId && record(value.turn).id !== this.turnId) return;
        this.bindTurn(record(value.turn).id);
        return;
      }
      if (method === "turn/completed") {
        const turn = record(value.turn);
        if (this.turnId !== turn.id) return;
        this.nativeEnded = true;
        this.end();
        this.enqueue(async () => {
          if (this.waiting) this.resolve({ status: "waiting_clarification" });
          else if (turn.status === "completed" && this.content.trim())
            this.resolve({ status: "completed", content: this.content });
          else this.fail(new ApplicationError("INTERNAL_ERROR", "模型未返回完整分析结果"));
        });
        return;
      }
      if (this.stopped || this.waiting || value.turnId !== this.turnId) return;
      if (!["item/started", "item/completed"].includes(method)) return;
      const item = record(value.item);
      if (item.type === "agentMessage" && method === "item/completed")
        this.content = z.string().parse(item.text);
      if (item.type === "contextCompaction") {
        const itemId = identifier(item.id);
        const status = method === "item/started" ? "started" : "completed";
        const key = `${status}:${itemId}`;
        if (this.compactions.has(key)) return;
        this.compactions.add(key);
        this.enqueue(async () => {
          await this.request.onCompaction?.({ itemId, status });
        });
      }
    } catch (error) {
      this.fail(error);
    }
  }
  private enqueue(action: () => Promise<void>): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped) await action();
      })
      .catch((error: unknown) => this.fail(error));
  }
  /** 等待对应轮次终止；确认失败时保留线程占用，直到官方发来终止事件或进程退出。 */
  async interrupt(client: CodexAppServer): Promise<void> {
    this.stopped = true;
    if (!this.turnId || this.nativeEnded) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await client.request(
        "turn/interrupt",
        { threadId: this.threadId, turnId: this.turnId },
        2000,
      );
      await Promise.race([
        this.completion,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } catch {
      /* 保留未确认结束的轮次，避免同一线程重叠执行。 */
    } finally {
      clearTimeout(timer);
    }
  }
}

export { CodexSessionRouter };
