import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAnalysisHarness } from "../../ai-data/apps/api/src/harness/codex-analysis-harness.ts";
import { ModelCapabilities } from "../../ai-data/apps/api/src/models/model-capabilities.ts";
import { contextBudget } from "../../ai-data/apps/api/src/runtime/context-budget.ts";
import { readConfiguredDialogueRuntime } from "../../ai-data/apps/api/tests/integration/dialogue-model-fixture.ts";

// 隔离官方线程使用合成分页记录验证压缩与追问，正式业务库只读模型配置。
const root = fileURLToPath(new URL("../../ai-data", import.meta.url));
const { provider } = await readConfiguredDialogueRuntime();
const capability = await new ModelCapabilities().probe(provider);
const budget = contextBudget({
  serviceWindow:
    capability.status === "available" ? capability.contextWindow : undefined,
  modelWindow: provider.contextWindow,
});
const directory = resolve(
  root,
  "apps/api/secrets/context-compaction-acceptance",
);
await mkdir(directory, { recursive: true });
const record: Record<string, unknown> = {
  capability,
  budget,
  calls: [],
  compactions: [],
};
const calls = record.calls as number[];
const compactions = record.compactions as unknown[];
let harness = new CodexAnalysisHarness({
  provider,
  stateDirectory: directory,
  ...budget,
  timeoutMs: 600000,
});
let threadId: string | undefined;
const instructions =
  "你是分页数据核对助手。按用户要求依次调用 read_page，页码必须逐页递增且不重复。每次调用后继续取下一页，读完才能答复。工具已给出每页完整总计，使用总计核对。需要压缩时保留已读页码、累计条数与总计、日期和校验码。";
const tools = [
  {
    name: "read_page",
    description: "读取指定一页的完整验收记录和该页完整总计。",
    inputSchema: {
      type: "object",
      properties: { page: { type: "integer", minimum: 1, maximum: 8 } },
      required: ["page"],
      additionalProperties: false,
    },
  },
];
const run = (input: string) =>
  harness.run({
    sessionKey: "compaction-acceptance",
    threadId,
    instructions,
    input,
    tools,
    signal: new AbortController().signal,
    onThreadStarted: async (id) => {
      if (threadId && threadId !== id) throw new Error("恢复线程不一致");
      threadId = id;
      record.thread_id = id;
    },
    onCompaction: async (event) => {
      compactions.push(event);
      console.log(`compaction:${event.status}`);
    },
    executeTool: async (name, input) => {
      const page = (input as { page: number }).page;
      if (
        name !== "read_page" ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > 8 ||
        calls.includes(page)
      )
        throw new Error("验收工具参数或顺序无效");
      calls.push(page);
      console.log(`page:${page}`);
      const rows = Array.from({ length: 150 }, (_, index) => ({
        item_id: (page - 1) * 150 + index + 1,
        value: (page - 1) * 150 + index + 1,
        note: "本条为当日已确认的库存核对记录，明细仅用于本次验收",
      }));
      return {
        success: true,
        output: {
          page,
          rows,
          count: rows.length,
          page_total: rows.reduce((sum, row) => sum + row.value, 0),
          evidence_id: `page-${page}`,
        },
      };
    },
  });
try {
  record.first = await run(
    "核对日期为2026-09-27，校验码 RH-4826。请依次读取第1到第8页，最终回答完整条数、合计值、日期和校验码，不要复述明细。全部数据为合成验收数据。",
  );
  if (
    !compactions.some(
      (event) => (event as { status: string }).status === "completed",
    )
  )
    throw new Error("未观察到真实压缩完成");
  if (calls.join(",") !== "1,2,3,4,5,6,7,8")
    throw new Error("没有读完全部页码");
  await harness.close();
  harness = new CodexAnalysisHarness({
    provider,
    stateDirectory: directory,
    ...budget,
    timeoutMs: 180000,
  });
  record.followup = await run(
    "沿用刚才已经核对的结果，不要再次调用工具，请重述条数、总计和校验码。",
  );
  record.expected = { count: 1200, total: 720600, check: "RH-4826" };
  record.status = "completed";
} catch (error) {
  record.status = "failed";
  record.error = String(error);
  process.exitCode = 1;
} finally {
  await harness.close();
  await writeFile(
    new URL("./长会话压缩验收.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
}
