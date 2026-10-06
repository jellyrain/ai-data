import { spawn } from "node:child_process";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";

// 在隔离官方线程中转发一次真实请求，只保存协议结构和公开错误。
const api = resolve("apps/api");
const sdkRequire = createRequire(
  await realpath(join(api, "node_modules/@openai/codex-sdk/package.json")),
);
const codexPackage = sdkRequire.resolve("@openai/codex/package.json");
const platformRequire = createRequire(codexPackage);
const binary = join(
  dirname(platformRequire.resolve("@openai/codex-win32-x64/package.json")),
  "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
);
const state = resolve("apps/api/secrets/deferred-capability-probe");
await mkdir(state, { recursive: true });
const evidence = {
  checked_at: new Date().toISOString(),
  requests: [],
  errors: [],
  toolCalls: [],
};
let child;
let finish;
const finished = new Promise((done) => {
  finish = done;
});
const server = createServer(async (request, response) => {
  try {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body = JSON.parse(text);
    const recorded = { path: request.url, tools: body.tools, status: null };
    evidence.requests.push(recorded);
    const upstream = await fetch(
      `${process.env.MODEL_URL ?? "http://192.168.110.208:8000/v1"}${request.url.replace(/^\/v1/, "")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.MODEL_API_KEY}`,
        },
        body: text,
        signal: AbortSignal.timeout(45000),
      },
    );
    recorded.status = upstream.status;
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    });
    if (!upstream.ok) {
      const error = await upstream.text();
      recorded.error = error.slice(0, 1000);
      response.end(error);
    } else {
      for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    }
  } catch (error) {
    evidence.errors.push(String(error));
    response.writeHead(502).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    ["PATH", "SYSTEMROOT", "WINDIR"].includes(name.toUpperCase()),
  ),
);
Object.assign(env, {
  CODEX_HOME: state,
  HOME: state,
  USERPROFILE: state,
  LOCALAPPDATA: state,
  APPDATA: state,
  TEMP: state,
  TMP: state,
});
const config = {
  model_provider: "probe",
  "model_providers.probe.name": "probe",
  "model_providers.probe.base_url": `http://127.0.0.1:${server.address().port}/v1`,
  "model_providers.probe.wire_api": "responses",
  "model_providers.probe.request_max_retries": 0,
  "model_providers.probe.stream_max_retries": 0,
  project_doc_max_bytes: 0,
  "features.shell_tool": false,
  "features.apply_patch_freeform": false,
  "features.view_image": false,
  "features.multi_agent": false,
  "features.goals": false,
  web_search: "disabled",
  check_for_update_on_startup: false,
  model_context_window: 32768,
  model_auto_compact_token_limit: 24576,
};
child = spawn(
  binary,
  [
    "app-server",
    ...Object.entries(config).flatMap(([key, value]) => [
      "-c",
      `${key}=${JSON.stringify(value)}`,
    ]),
  ],
  { cwd: state, env, stdio: "pipe", windowsHide: true },
);
child.stderr.resume();
const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
const pending = new Map();
let sequence = 0;
const rpc = (method, params) =>
  new Promise((done, reject) => {
    const id = ++sequence;
    pending.set(id, { done, reject });
    send({ id, method, params });
  });
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.error) evidence.errors.push(message.error);
  if (pending.has(message.id)) {
    const target = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) target.reject(new Error(JSON.stringify(message.error)));
    else target.done(message.result);
  } else if (message.method === "item/tool/call") {
    evidence.toolCalls.push({
      tool: message.params.tool,
      namespace: message.params.namespace,
    });
    send({
      id: message.id,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: '{"fee":42}' }],
      },
    });
  } else if (message.method === "turn/completed") {
    evidence.completion = message.params.turn.status;
    finish();
  }
});
const timeout = setTimeout(finish, 60000);
try {
  await rpc("initialize", {
    clientInfo: { name: "ai_data_deferred_probe", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized" });
  const result = await rpc("thread/start", {
    model: "rj-model-v1",
    cwd: state,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions:
      "Use tool discovery to find query_fee, call it once, then state the returned fee.",
    dynamicTools: [
      {
        type: "namespace",
        name: "business",
        description: "Business fee queries",
        tools: [
          {
            type: "function",
            name: "query_fee",
            description: "query_fee returns the fee",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            deferLoading: true,
          },
        ],
      },
    ],
  });
  await rpc("turn/start", {
    threadId: result.thread.id,
    input: [{ type: "text", text: "请查询费用并回答。" }],
  });
  await finished;
} catch (error) {
  evidence.errors.push(String(error));
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  const target = new URL("./延迟工具兼容性.json", import.meta.url);
  await writeFile(target, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}
