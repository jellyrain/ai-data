import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 只导出大小、token 计数、工具名及公开错误，不复制模型推理内容。
const root = fileURLToPath(
  new URL(
    "../../ai-data/apps/api/secrets/codex-runtime/home/sessions/2026/09/27/",
    import.meta.url,
  ),
);
const baseline = JSON.parse(
  readFileSync(
    new URL(
      "../前端第4步业务造数与验收/20260927-模型复验/上下文诊断证据.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const files = readdirSync(root).filter((name) =>
  [
    "01a0e35d-42a5-7f60-9e5a-f530a9f6cd66",
    "01a0e360-9ab2-7963-b65f-836186cb9666",
    "01a0e361-f227-79d3-8c5e-b755039e8a78",
  ].some((id) => name.includes(id)),
);
const bytes = (value) =>
  Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const results = files.map((name) => {
  const rows = readFileSync(join(root, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const meta = rows.find((row) => row.type === "session_meta").payload;
  const tokens = rows
    .filter(
      (row) =>
        row.type === "event_msg" &&
        row.payload.type === "token_count" &&
        row.payload.info,
    )
    .map((row) => row.payload.info.last_token_usage);
  const items = rows
    .filter((row) => row.type === "response_item")
    .map((row) => row.payload);
  const initial = items.find(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      item.content.some((part) => part.text?.startsWith('{"conversation"')),
  );
  const text =
    initial?.content
      .filter((part) => part.type === "input_text")
      .map((part) => part.text)
      .join("\n") ?? "";
  let prompt;
  try {
    prompt = JSON.parse(text);
  } catch {
    /* Skill 指令不参与 JSON 计量。 */
  }
  const outputs = items.filter((item) => item.type === "function_call_output");
  return {
    rollout_file: name,
    configured_context_window: meta.context_window,
    initial_input_tokens: tokens[0]?.input_tokens,
    last_usage: tokens.at(-1),
    tools_count: meta.dynamic_tools.length,
    tool_bytes: meta.dynamic_tools.reduce((sum, tool) => sum + bytes(tool), 0),
    tools: meta.dynamic_tools.map((tool) => ({
      name: tool.name,
      bytes: bytes(tool),
    })),
    initial_prompt_bytes: bytes(text),
    initial_memory_bytes: prompt?.memory ? bytes(prompt.memory) : null,
    initial_knowledge_count: prompt?.memory?.knowledge.length ?? null,
    calls: items
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        name: item.name,
        arguments_bytes: bytes(item.arguments),
      })),
    output_bytes: outputs.reduce((sum, item) => sum + bytes(item.output), 0),
    errors: outputs
      .map((item) => {
        try {
          const data =
            typeof item.output === "string"
              ? JSON.parse(item.output)
              : item.output;
          return data;
        } catch {
          return null;
        }
      })
      .filter((item) => item?.code && item?.message),
  };
});
const fees = results.find((row) => row.rollout_file.includes("01a0e35d"));
const report = {
  measurement:
    "token 来自模型 usage；体积为逐条 JSON 的 UTF-8 字节。输出只包含计量和公开工具失败信息。",
  before: {
    initial_input_tokens: baseline.initial_input_tokens,
    tool_bytes: baseline.tool_definitions.reduce(
      (sum, item) => sum + item.bytes,
      0,
    ),
    auto_compact_token_limit: baseline.observed_auto_compact_threshold,
  },
  after: results,
  fees_initial_token_reduction_percent: Number(
    (
      (1 - fees.initial_input_tokens / baseline.initial_input_tokens) *
      100
    ).toFixed(1),
  ),
};
writeFileSync(
  new URL("上下文前后计量.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      before: report.before,
      after: results.map(
        ({
          rollout_file,
          initial_input_tokens,
          tool_bytes,
          tools_count,
          initial_memory_bytes,
          initial_knowledge_count,
          last_usage,
          output_bytes,
        }) => ({
          rollout_file,
          initial_input_tokens,
          tool_bytes,
          tools_count,
          initial_memory_bytes,
          initial_knowledge_count,
          last_usage,
          output_bytes,
        }),
      ),
      reduction_percent: report.fees_initial_token_reduction_percent,
    },
    null,
    2,
  ),
);
