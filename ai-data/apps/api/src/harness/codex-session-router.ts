import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import type { CodexAppServer } from "./codex-app-server";
import type {
  HarnessMessage,
  HarnessMessageState,
  HarnessRequest,
  HarnessResult,
} from "./harness-types";

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
  private messageId?: string;
  private hasFinalMessage = false;
  private readonly messages = new Map<string, HarnessMessageState>();
  private pending?: HarnessMessage;
  private flushTimer?: NodeJS.Timeout;
  private queued = 0;
  private queuedBytes = 0;
  /** 仅指向队尾尚未开始提交的增量；任何有序边界都会结束本次合并。 */
  private queuedDelta?: HarnessMessage;
  private textLength = 0;
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
    this.clearPending();
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
      this.flushText();
      this.queuedDelta = undefined;
      const task = this.queue.then(async () => {
        if (this.stopped || this.waiting || this.request.signal.aborted)
          throw new ApplicationError("CANCELLED", "分析已停止");
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
        this.flushText();
        this.enqueue(async () => {
          if (this.waiting) this.resolve({ status: "waiting_clarification" });
          else if (
            turn.status === "completed" &&
            this.content.trim() &&
            [...this.messages.values()].every((message) => message.completed)
          )
            this.resolve({
              status: "completed",
              content: this.content,
              ...(this.request.onMessage && this.messageId ? { messageId: this.messageId } : {}),
            });
          else this.fail(new ApplicationError("INTERNAL_ERROR", "模型未返回完整分析结果"));
        });
        return;
      }
      if (
        this.stopped ||
        this.waiting ||
        this.nativeEnded ||
        this.request.signal.aborted ||
        value.turnId !== this.turnId
      )
        return;
      if (method === "item/agentMessage/delta") {
        const itemId = identifier(value.itemId);
        const delta = z.string().parse(value.delta);
        const message = this.message(itemId);
        if (message.completed || !delta) return;
        this.limitText(delta.length, message.content.length + delta.length);
        message.content += delta;
        if (this.pending?.itemId !== itemId) this.flushText();
        this.pending ??= {
          itemId,
          status: "delta",
          content: "",
          ...(message.phase ? { phase: message.phase } : {}),
        };
        this.pending.content += delta;
        if (this.pending.content.length >= 2048) this.flushText();
        else this.flushTimer ??= setTimeout(() => this.flushText(), 120);
        return;
      }
      if (!["item/started", "item/completed"].includes(method)) return;
      const item = record(value.item);
      if (item.type === "agentMessage") {
        const itemId = identifier(item.id);
        const message = this.message(itemId, item.phase);
        if (message.completed) return;
        if (method === "item/completed") {
          const content = z.string().parse(item.text);
          this.limitText(Math.max(0, content.length - message.content.length), content.length);
          this.flushText();
          message.content = content;
          message.completed = true;
          this.publish({
            itemId,
            status: "completed",
            content,
            ...(message.phase ? { phase: message.phase } : {}),
          });
          if (message.phase === "final_answer" || !this.hasFinalMessage) {
            this.content = content;
            this.messageId = itemId;
            this.hasFinalMessage = message.phase === "final_answer";
          }
        }
      }
      if (item.type === "contextCompaction") {
        const itemId = identifier(item.id);
        const status = method === "item/started" ? "started" : "completed";
        const key = `${status}:${itemId}`;
        if (this.compactions.has(key)) return;
        this.compactions.add(key);
        this.flushText();
        this.enqueue(async () => {
          await this.request.onCompaction?.({ itemId, status });
        });
      }
    } catch (error) {
      this.fail(error);
    }
  }
  private enqueue(action: () => Promise<void>): void {
    this.queuedDelta = undefined;
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped && !this.request.signal.aborted) await action();
      })
      .catch((error: unknown) => this.fail(error));
  }
  private message(itemId: string, phase?: unknown): HarnessMessageState {
    if (itemId.length > 256)
      throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "助手消息标识超过容量");
    const existing = this.messages.get(itemId);
    const parsedPhase = phase === "commentary" || phase === "final_answer" ? phase : undefined;
    if (existing) {
      if (parsedPhase) existing.phase = parsedPhase;
      return existing;
    }
    if (this.messages.size >= 200)
      throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "助手消息数量超过容量");
    this.flushText();
    const message: HarnessMessageState = {
      content: "",
      completed: false,
      ...(parsedPhase ? { phase: parsedPhase } : {}),
    };
    this.messages.set(itemId, message);
    this.publish({
      itemId,
      status: "started",
      content: "",
      ...(parsedPhase ? { phase: parsedPhase } : {}),
    });
    return message;
  }
  private limitText(added: number, length: number): void {
    this.textLength += added;
    if (length > 64000 || this.textLength > 256000)
      throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "助手文字超过分析容量");
  }
  private publish(event: HarnessMessage): void {
    if (!this.request.onMessage || this.stopped || this.request.signal.aborted) return;
    const bytes = Buffer.byteLength(event.content, "utf8");
    const previous = this.queuedDelta;
    const merge =
      event.status === "delta" &&
      previous?.itemId === event.itemId &&
      previous.phase === event.phase &&
      previous.content.length + event.content.length <= 64000;
    if ((!merge && this.queued >= 128) || this.queuedBytes + bytes > 512000) {
      this.fail(new ApplicationError("QUERY_LIMIT_EXCEEDED", "助手文字提交队列已满"));
      return;
    }
    this.queuedBytes += bytes;
    if (merge) {
      previous.content += event.content;
      return;
    }
    this.queued++;
    this.enqueue(async () => {
      // 回调开始后冻结其正文，后续增量进入下一批，避免修改正在持久化的事件。
      if (this.queuedDelta === event) this.queuedDelta = undefined;
      try {
        await this.request.onMessage!(event);
      } finally {
        this.queued--;
        this.queuedBytes -= Buffer.byteLength(event.content, "utf8");
      }
    });
    if (event.status === "delta") this.queuedDelta = event;
  }
  private flushText(): void {
    const pending = this.pending;
    this.clearPending();
    if (pending?.content) this.publish(pending);
  }
  private clearPending(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = undefined;
  }
  /** 等待对应轮次终止；确认失败时保留线程占用，直到官方发来终止事件或进程退出。 */
  async interrupt(client: CodexAppServer): Promise<void> {
    this.stopped = true;
    this.clearPending();
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
