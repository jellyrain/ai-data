import { Readable } from "node:stream";
import { z } from "zod";
import { clarificationAnswerSchema, queryDslSchema } from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiAnalysisServices, ApiAuthService } from "../app-types";
import { ApplicationError } from "../errors/application-error";
import { bearerToken } from "./auth-routes";
import type { AnalysisDispatcher } from "../runtime/runtime-types";

const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const queryInputSchema = z
  .object({ idempotency_key: z.string().min(1).max(128), query: queryDslSchema })
  .strict();
const cursorSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(2147483647));

/** 回放使用持久化序号；每次读取重新加载身份，连接关闭后停止轮询。 */
function registerAnalysisRoutes(
  app: FastifyInstance,
  auth: ApiAuthService,
  runs: ApiAnalysisServices["runs"],
  dispatcher?: Pick<AnalysisDispatcher, "wake">,
): void {
  app.get("/analysis-runs/:id", async (request) =>
    runs.get(await auth.loadContext(bearerToken(request)), paramsSchema.parse(request.params).id),
  );
  app.get("/analysis-runs/:id/evidence", async (request) => ({
    items: await runs.evidence(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  }));
  app.get("/analysis-runs/:id/steps", async (request) => ({
    items: await runs.steps(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  }));
  app.post("/analysis-runs/:id/answers", async (request) => {
    const state = await runs.answer(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
      clarificationAnswerSchema.parse(request.body),
    );
    if (state.status === "created") dispatcher?.wake();
    return state;
  });
  app.post("/analysis-runs/:id/cancel", async (request) =>
    runs.cancel(
      await auth.loadContext(bearerToken(request)),
      paramsSchema.parse(request.params).id,
    ),
  );
  app.post("/analysis-runs/:id/queries", async (request) => {
    const context = await auth.loadContext(bearerToken(request));
    const input = queryInputSchema.parse(request.body);
    return runs.execute(
      context,
      paramsSchema.parse(request.params).id,
      input.idempotency_key,
      input.query,
    );
  });
  app.get("/analysis-runs/:id/events", async (request, reply) => {
    const token = bearerToken(request);
    const id = paramsSchema.parse(request.params).id;
    let after = cursorSchema.parse(request.headers["last-event-id"] ?? "0");
    const initial = await runs.get(await auth.loadContext(token), id);
    if (after > initial.sequence)
      throw new ApplicationError("INVALID_INPUT", "事件游标超过当前运行序号");
    const controller = new AbortController();
    const close = () => controller.abort();
    reply.raw.once("close", close);
    async function* stream() {
      let wake: (() => void) | undefined;
      let changed: boolean;
      let timer: NodeJS.Timeout | undefined;
      const unsubscribe = runs.subscribeEvents?.(id, () => {
        changed = true;
        wake?.();
      });
      const aborted = () => wake?.();
      controller.signal.addEventListener("abort", aborted);
      try {
        while (!controller.signal.aborted) {
          changed = false;
          const context = await auth.loadContext(token);
          const { state, events } = await runs.readEventBatch(context, id, after);
          for (const event of events) {
            if (controller.signal.aborted) return;
            yield `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            after = event.sequence;
          }
          if (
            ["completed", "failed", "cancelled"].includes(state.status) &&
            after >= state.sequence
          )
            return;
          if (events.length === 200) continue;
          if (!events.length) yield ": keep-alive\n\n";
          // 订阅先于读取，读取期间提交的事件不会错过唤醒；跨实例保留一秒回放。
          if (!changed && !controller.signal.aborted)
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, 1000);
            });
          clearTimeout(timer);
          wake = undefined;
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        clearTimeout(timer);
        unsubscribe?.();
        controller.signal.removeEventListener("abort", aborted);
        reply.raw.removeListener("close", close);
      }
    }
    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("x-accel-buffering", "no")
      .send(Readable.from(stream()));
  });
}
export { registerAnalysisRoutes };
