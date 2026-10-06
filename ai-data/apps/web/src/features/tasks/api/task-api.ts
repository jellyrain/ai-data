import { z } from "zod";
import { memoryEventSummarySchema, analysisRunSchema } from "@ai-data/contracts";
import type { MemoryEventSummary } from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
/** 后台管理只读取公开状态摘要，失败重试后仍须回读实际状态。 */
class TaskApi {
  constructor(private readonly request: Transport) {}
  async source(runId: string) {
    return analysisRunSchema.parse(
      await this.request("/api/analysis-runs/" + encodeURIComponent(runId)),
    ).conversation_id;
  }
  async list(limit = 50) {
    return z
      .object({ items: z.array(memoryEventSummarySchema) })
      .strict()
      .parse(await this.request("/api/admin/memory-events?limit=" + limit)).items;
  }
  async retry(id: string, status: MemoryEventSummary["status"]) {
    if (status !== "failed") throw new Error("只有失败任务可以重试");
    z.undefined().parse(
      await this.request("/api/admin/memory-events/" + encodeURIComponent(id) + "/retry", {
        method: "POST",
      }),
    );
  }
}
export { TaskApi };
