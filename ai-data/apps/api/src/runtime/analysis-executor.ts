import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type { ExecutorDependencies } from "./runtime-types";
import { modelQueryResult } from "./model-query-result";

/** 一次租约内连续执行工具；已提交的消息、澄清和证据组成恢复上下文。 */
class AnalysisExecutor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private closing = false;
  constructor(private readonly dependencies: ExecutorDependencies) {}

  execute(context: AuthContext, runId: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    const existing = this.active.get(runId);
    if (existing) return existing;
    const task = this.run(context, runId).finally(() => this.active.delete(runId));
    this.active.set(runId, task);
    return task;
  }

  private async run(context: AuthContext, runId: string): Promise<void> {
    const { runs, harness, tools, repository } = this.dependencies;
    context = await this.dependencies.refreshContext(context);
    let lease;
    try {
      lease = await runs.claim(context, runId, randomUUID());
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "CONFLICT") return;
      throw error;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const detach = runs.attachController(runId, controller);
    let heartbeat: Promise<void> | undefined;
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = runs
        .renew(context, runId, lease)
        .then(() => {})
        .catch((error: unknown) => {
          heartbeatError = error;
          controller.abort();
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, this.dependencies.heartbeatMs ?? 5000);
    timer.unref();
    let calls = 0;
    try {
      const definitions = tools.definitions();
      const runtimeKey = createHash("sha256")
        .update(
          stableStringify({
            tools: definitions,
            instructions: this.dependencies.instructions,
            runtime: this.dependencies.runtimeKey ?? "",
          }),
        )
        .digest("hex");
      const input = await repository.loadInput(context, runId, runtimeKey);
      const evidence = [];
      // 恢复官方线程前，复核其所属业务会话内全部历史证据。
      for (const id of input.run_ids) {
        await runs.get(context, id);
        for (const item of await runs.evidence(context, id))
          evidence.push({
            evidence_id: item.evidence_id,
            analysis_run_id: id,
            metric: item.metric,
            result: modelQueryResult(item.result),
          });
      }
      const prompt = JSON.stringify(
        input.thread_id
          ? {
              conversation: input.messages.slice(-1),
              evidence: evidence.filter((item) => item.analysis_run_id === runId),
            }
          : { conversation: input.messages, evidence },
      );
      if (Buffer.byteLength(prompt, "utf8") > (this.dependencies.maxContextBytes ?? 65536))
        throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "会话上下文超出分析容量");
      const result = await harness.run({
        sessionKey: JSON.stringify([
          context.organizationId,
          context.userId,
          input.conversation_id,
          input.context_hash,
        ]),
        threadId: input.thread_id,
        onThreadStarted: async (threadId) => {
          if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "分析已中断");
          await repository.saveThread(context, runId, lease, input.context_hash, threadId);
        },
        input: prompt,
        instructions: this.dependencies.instructions,
        tools: definitions,
        signal: controller.signal,
        onCompaction: async (event) => {
          if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "分析已中断");
          await runs.recordCompaction(context, runId, lease, event);
        },
        executeTool: async (name, value, callId) => {
          if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "分析已中断");
          if (++calls > (this.dependencies.maxToolCalls ?? 50))
            throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "本轮工具调用次数已达上限");
          return tools.execute(context, runId, lease, name, value, callId);
        },
      });
      if (controller.signal.aborted)
        throw heartbeatError ?? new ApplicationError("CANCELLED", "分析已中断");
      if (result.status === "completed") {
        if (!result.content.trim() || result.content.length > 64000)
          throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "分析结论为空或超过容量");
        const current = await this.dependencies.refreshContext(context);
        if (
          (await repository.loadInput(current, runId, runtimeKey)).context_hash !==
          input.context_hash
        )
          throw new ApplicationError("POLICY_REJECTED", "分析期间授权范围发生变化，请重新发起分析");
        for (const id of input.run_ids) await runs.get(current, id);
        await runs.complete(current, runId, lease, result.content);
      }
    } catch (error) {
      if (this.closing) await runs.release(context, runId, lease);
      else await runs.fail(context, runId, lease, heartbeatError ?? error);
      await runs.interrupt(runId);
    } finally {
      clearInterval(timer);
      await heartbeat;
      detach();
      this.controllers.delete(controller);
    }
  }

  /** 关闭时先中断模型，再等待在途执行释放租约和连接。 */
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
export { AnalysisExecutor };
