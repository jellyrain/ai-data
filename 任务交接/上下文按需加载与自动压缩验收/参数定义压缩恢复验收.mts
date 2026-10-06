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
  "apps/api/secrets/schema-compaction-acceptance",
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
  "第一次读页之前、全部页读完之后，分别调用一次 get_tool_schema 读取 read_page 参数定义。你是分页数据核对助手。按用户要求依次调用 read_page，页码必须逐页递增且不重复。每次调用后继续取下一页，读完才能答复。工具已给出每页完整总计，使用总计核对。需要压缩时保留已读页码、累计条数与总计、日期和校验码。";
const pageTools = [
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
const schemaReads: number[] = [];
record.schema_reads_at_page = schemaReads;
const schemaTool = {
  name: "get_tool_schema",
  description: "按需读取 read_page 的完整参数定义。",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" } },
    required: ["tool_name"],
    additionalProperties: false,
  },
};
const tools = [
  schemaTool,
  {
    ...pageTools[0],
    description:
      "先使用 get_tool_schema 读取 read_page 参数定义，调用时将业务参数对象序列化到 arguments_json。",
    inputSchema: {
      type: "object",
      properties: { arguments_json: { type: "string" } },
      required: ["arguments_json"],
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
      if (name === "get_tool_schema") {
        schemaReads.push(calls.length);
        console.log("schema:" + calls.length);
        return {
          success: true,
          output: { name: "read_page", input_schema: pageTools[0].inputSchema },
        };
      }
      const page = JSON.parse(
        (input as { arguments_json: string }).arguments_json,
      ).page;
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
    "核对日期为2026-09-27，校验码 RH-4826。本次核对口径固定为 synthetic-count-v2，用户条件固定为 department-A；引用完整证据范围 page-1 至 page-8。请依次读取第1到第8页，最终回答完整条数、合计值、日期、校验码、固定口径版本、用户条件和证据范围，不要复述明细。全部数据为合成验收数据。",
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
    "沿用刚才核对结果，先调用 get_tool_schema 重新读取 read_page 的定义，不要读取任何数据页，再重述条数、总计、日期、校验码、之前固定的口径版本、用户条件和证据范围。",
  );
  if (
    schemaReads[0] !== 0 ||
    schemaReads.filter((page) => page === 8).length < 2
  )
    throw new Error("未完成压缩后及重启后的定义重读");
  for (const value of [record.first, record.followup]) {
    const result = value as { status: string; content: string };
    if (
      result.status !== "completed" ||
      ![
        "1200",
        "720600",
        "RH-4826",
        "2026-09-27",
        "synthetic-count-v2",
        "department-A",
        "page-1",
        "page-8",
      ].every((text) => result.content.replaceAll(",", "").includes(text))
    )
      throw new Error("压缩恢复丢失验收条件或结果");
  }
  record.expected = {
    count: 1200,
    total: 720600,
    check: "RH-4826",
    metric: "synthetic-count-v2",
    condition: "department-A",
    evidence: ["page-1", "page-8"],
  };
  record.status = "completed";
} catch (error) {
  record.status = "failed";
  record.error = String(error);
  process.exitCode = 1;
} finally {
  await harness.close();
  await writeFile(
    new URL("./参数定义压缩恢复验收.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
}
