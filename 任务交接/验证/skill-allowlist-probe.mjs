import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** 用虚拟 Skill 和本机 Responses 服务核查已安装 Harness 的可见范围。 */
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const api = join(workspace, "ai-data/apps/api");
const sdk = join(api, "node_modules/@openai/codex-sdk/dist/index.js");
const localRequire = createRequire(await realpath(sdk));
const packagePath = localRequire.resolve("@openai/codex/package.json");
const platform = createRequire(packagePath).resolve("@openai/codex-win32-x64/package.json");
const executable = join(dirname(platform), "vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const parent = resolve(api, "secrets");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, "skill-allowlist-probe-"));
const home = join(root, "home");
const work = join(root, "work");
const shared = join(root, "shared-resources");
await Promise.all(
  [home, work, shared, join(root, "tmp")].map((p) => mkdir(p, { recursive: true })),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    ["PATH", "SYSTEMROOT", "WINDIR"].includes(k.toUpperCase()),
  ),
);
Object.assign(env, {
  CODEX_HOME: home,
  HOME: home,
  USERPROFILE: home,
  APPDATA: home,
  LOCALAPPDATA: home,
  TEMP: join(root, "tmp"),
  TMP: join(root, "tmp"),
  PROBE_API_KEY: "probe-only",
});
const result = {
  version: JSON.parse(await readFile(packagePath, "utf8")).version,
  cases: [],
  toolCalls: [],
  requests: [],
};
const plans = new Map();
const scopes = new Map();
const captures = [];
let sequence = 0;
let client;

function emit(response, type, fields) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
}
const server = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body);
    captures.push(payload);
    const serialized = JSON.stringify(payload);
    const tag = [...serialized.matchAll(/CASE_\d+/g)].at(-1)?.[0];
    const plan = plans.get(tag);
    const id = `probe_${++sequence}`;
    let item;
    if (plan?.tool && !serialized.includes(`call_${tag}`)) {
      item = {
        type: "function_call",
        id: `fc_${id}`,
        call_id: `call_${tag}`,
        name: "read_skill_reference",
        arguments: JSON.stringify({ skill_name: plan.tool, relative_path: "references/detail.md" }),
      };
    } else {
      item = {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "probe complete", annotations: [] }],
      };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    emit(response, "response.created", { response: { id, status: "in_progress", output: [] } });
    emit(response, "response.output_item.added", {
      output_index: 0,
      item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] },
    });
    if (item.type === "function_call") {
      emit(response, "response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
    } else {
      emit(response, "response.content_part.added", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      emit(response, "response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "probe complete",
      });
    }
    emit(response, "response.output_item.done", { output_index: 0, item });
    emit(response, "response.completed", {
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    });
    response.end();
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const baseConfig = {
  model_provider: "probe",
  "model_providers.probe.name": "probe",
  "model_providers.probe.base_url": `http://127.0.0.1:${port}/v1`,
  "model_providers.probe.wire_api": "responses",
  "model_providers.probe.env_key": "PROBE_API_KEY",
  "model_providers.probe.request_max_retries": 0,
  "model_providers.probe.stream_max_retries": 0,
  check_for_update_on_startup: false,
  project_doc_max_bytes: 0,
  project_root_markers: [],
  "memories.generate_memories": false,
  "memories.use_memories": false,
  "features.shell_tool": false,
  "features.apply_patch_freeform": false,
  "features.multi_agent": false,
  "features.goals": false,
  "features.view_image": false,
  "features.image_generation": false,
  "features.skill_mcp_dependency_install": false,
  "features.apps": false,
  "features.plugins": false,
  web_search: "disabled",
};

class Client {
  nextId = 0;
  pending = new Map();
  notifications = [];
  stderr = "";
  constructor(config = {}) {
    this.process = spawn(
      executable,
      [
        "app-server",
        ...Object.entries({ ...baseConfig, ...config }).flatMap(([k, v]) => [
          "-c",
          `${k}=${JSON.stringify(v)}`,
        ]),
      ],
      { cwd: work, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.exited = new Promise((done) => this.process.once("exit", done));
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        void this.onRequest(message);
      } else if (message.method) {
        this.notifications.push(message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error
          ? pending.reject(new Error(JSON.stringify(message.error)))
          : pending.resolve(message.result);
      }
    });
  }
  send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout: ${this.stderr.slice(-1500)}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async onRequest(message) {
    if (message.method !== "item/tool/call") {
      this.send({ id: message.id, error: { code: -32601, message: "Unsupported probe request" } });
      return;
    }
    const { threadId, arguments: raw } = message.params;
    const input = typeof raw === "string" ? JSON.parse(raw) : raw;
    const scope = scopes.get(threadId);
    const allowed =
      scope?.has(input.skill_name) === true && input.relative_path === "references/detail.md";
    const output = allowed
      ? await readFile(join(shared, input.skill_name, input.relative_path), "utf8")
      : "PROBE_DENIED";
    result.toolCalls.push({ threadId, skill: input.skill_name, allowed });
    this.send({
      id: message.id,
      result: { success: allowed, contentItems: [{ type: "inputText", text: output }] },
    });
  }
  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "skill_allowlist_probe", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  async close() {
    this.process.stdin.end();
    const kill = setTimeout(() => this.process.kill(), 3000);
    await this.exited;
    clearTimeout(kill);
  }
}

async function makeSkill(base, name) {
  const directory = join(base, name);
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: DESC_${name}\n---\n\nBODY_${name}\nRead references/detail.md when requested.\n`,
  );
  await writeFile(join(directory, "references/detail.md"), `DETAIL_${name}`);
  return { type: "skill", name, path: join(directory, "SKILL.md") };
}
const tool = {
  name: "read_skill_reference",
  description: "Read an authorized skill reference.",
  inputSchema: {
    type: "object",
    properties: { skill_name: { type: "string" }, relative_path: { type: "string" } },
    required: ["skill_name", "relative_path"],
    additionalProperties: false,
  },
};
async function start(config = {}, threadId) {
  const settings = {
    model: "probe-model",
    modelProvider: "probe",
    cwd: work,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: "Reply briefly. Use supplied skills.",
    config,
  };
  const response = await client.request(
    threadId ? "thread/resume" : "thread/start",
    threadId ? { ...settings, threadId } : { ...settings, dynamicTools: [tool] },
  );
  return response.thread.id;
}
let caseId = 0;
async function turn(label, threadId, skills = [], extra = {}) {
  const tag = `CASE_${++caseId}`;
  plans.set(tag, extra);
  const before = captures.length;
  const started = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: `${tag} ${skills.map((s) => `$${s.name}`).join(" ")} ${extra.text ?? ""} Please finish the probe.`,
      },
      ...skills,
    ],
  });
  const until = Date.now() + 20000;
  let completion;
  while (Date.now() < until) {
    completion = client.notifications.find(
      (n) =>
        n.method === "turn/completed" &&
        n.params.threadId === threadId &&
        n.params.turn.id === started.turn.id,
    );
    if (completion) break;
    await new Promise((done) => setTimeout(done, 20));
  }
  if (!completion || completion.params.turn.status !== "completed")
    throw new Error(
      `${label}: ${JSON.stringify(completion ?? client.notifications.slice(-3))}; ${client.stderr.slice(-500)}`,
    );
  const requests = captures.slice(before).filter((p) => JSON.stringify(p).includes(tag));
  const text = JSON.stringify(requests[0]);
  const catalog =
    (requests[0]?.input ?? [])
      .flatMap((message) => message.content ?? [])
      .map((part) => part.text ?? "")
      .filter((part) => part.includes("<skills_instructions>"))
      .at(-1) ?? "";
  const row = {
    label,
    threadId,
    requests: requests.length,
    currentCatalog: [...new Set(catalog.match(/DESC_[a-z-]+/g) ?? [])],
    descriptions: [...new Set(text.match(/DESC_[a-z-]+/g) ?? [])],
    bodies: [...new Set(text.match(/BODY_[a-z-]+/g) ?? [])],
    details: [...new Set(JSON.stringify(requests).match(/DETAIL_[a-z-]+|PROBE_DENIED/g) ?? [])],
  };
  result.cases.push(row);
  console.log(JSON.stringify(row));
  return row;
}

try {
  const a = await makeSkill(join(home, "skills"), "probe-a");
  const b = await makeSkill(join(home, "skills"), "probe-b");
  const outsideA = await makeSkill(shared, "probe-shared-a");
  const outsideB = await makeSkill(shared, "probe-shared-b");
  result.featureFlags = spawnSync(executable, ["features", "list"], {
    env,
    cwd: work,
    encoding: "utf8",
    windowsHide: true,
  })
    .stdout.split("\n")
    .filter((s) => s.includes("skill"));
  client = new Client();
  await client.initialize();
  const features = await client.request("experimentalFeature/list", {});
  result.skillFeatures = JSON.stringify(features).match(
    /.{0,180}skip_host_skill_discovery.{0,500}/g,
  );
  const baseline = await start();
  await turn("native-baseline", baseline, [a]);
  const positive = await start({ "skills.config": [{ path: a.path, enabled: true }] });
  await turn("native-enable-a-only", positive, [a]);
  const external = await start();
  await turn("explicit-shared-outside-discovery", external, [outsideA]);
  const externalConfigured = await start({
    "skills.config": [{ path: outsideA.path, enabled: true }],
  });
  await turn("explicit-shared-enabled-path", externalConfigured, [outsideA]);
  const skipped = await start({ "features.skip_host_skill_discovery": true });
  await turn("thread-skip-host-explicit-shared", skipped, [outsideA]);
  const skippedHome = await start({ "features.skip_host_skill_discovery": true });
  await turn("thread-skip-host-explicit-home", skippedHome, [a]);
  const blockedB = await start({ "skills.config": [{ path: b.path, enabled: false }] });
  await turn("disabled-b-explicit-invocation", blockedB, [b]);
  const implicit = await makeSkill(join(home, "skills"), "probe-explicit-only");
  await mkdir(join(dirname(implicit.path), "agents"), { recursive: true });
  await writeFile(
    join(dirname(implicit.path), "agents/openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n",
  );
  await client.request("skills/list", { cwds: [work], forceReload: true });
  const explicitOnly = await start();
  await turn("implicit-policy-catalog", explicitOnly);
  await turn("implicit-policy-explicit-invocation", explicitOnly, [implicit]);
  const textOnly = await start();
  await turn("implicit-policy-user-mention", textOnly, [], { text: "$probe-explicit-only" });
  const initialList = await client.request("skills/list", { cwds: [work], forceReload: true });
  const discovered = initialList.data.flatMap((entry) => entry.skills);
  const whitelist = (selected) => ({
    "skills.config": discovered.map((skill) => ({
      path: skill.path,
      enabled: selected.has(skill.name),
    })),
  });
  const configA = whitelist(new Set([a.name]));
  const configB = whitelist(new Set([b.name]));
  const threadA = await start(configA);
  const threadB = await start(configB);
  scopes.set(threadA, new Set([outsideA.name]));
  scopes.set(threadB, new Set([outsideB.name]));
  await Promise.all([
    turn("enumerated-whitelist-a", threadA, [a], { tool: outsideA.name }),
    turn("enumerated-whitelist-b", threadB, [b], { tool: outsideB.name }),
  ]);
  await turn("reference-cross-thread-rejected", threadA, [], { tool: outsideB.name });
  const c = await makeSkill(join(home, "skills"), "probe-new-c");
  await client.request("skills/list", { cwds: [work], forceReload: true });
  await turn("old-thread-after-new-skill", threadA);
  await turn("old-thread-invoke-new-skill", threadA, [c]);
  await client.close();
  client = new Client();
  await client.initialize();
  assert.equal(await start(configA, threadA), threadA);
  await turn("resume-old-enumeration", threadA);
  const refreshed = await client.request("skills/list", { cwds: [work], forceReload: true });
  const refreshedConfig = {
    "skills.config": refreshed.data
      .flatMap((entry) => entry.skills)
      .map((skill) => ({ path: skill.path, enabled: skill.name === a.name })),
  };
  assert.equal(await start(refreshedConfig, threadB), threadB);
  await turn("resume-refreshed-enumeration", threadB, [a]);
  await client.close();
  client = new Client({ "features.skip_host_skill_discovery": true });
  await client.initialize();
  const featureState = await client.request("experimentalFeature/list", {});
  result.skipFeatureWhenEnabled = JSON.stringify(featureState).match(
    /.{0,30}skip_host_skill_discovery.{0,220}/g,
  );
  const globalSkip = await start();
  await turn("process-skip-host-explicit-shared", globalSkip, [outsideA]);
  result.discovery = await client.request("skills/list", { cwds: [work], forceReload: true });
  // 对实际模型请求断言；恢复后的当前清单与历史已加载正文分别核查。
  const row = (label) => result.cases.find((entry) => entry.label === label);
  const checks = [
    [
      "原生发现两个 Skill，并加载选定入口",
      () => {
        assert.deepEqual(row("native-baseline").currentCatalog.sort(), [
          "DESC_probe-a",
          "DESC_probe-b",
        ]);
        assert.deepEqual(row("native-baseline").bodies, ["BODY_probe-a"]);
      },
    ],
    [
      "仅 enabled:true 不构成白名单",
      () => assert(row("native-enable-a-only").currentCatalog.includes("DESC_probe-b")),
    ],
    [
      "扫描范围外的显式路径没有加载正文",
      () => {
        assert.deepEqual(row("explicit-shared-outside-discovery").bodies, []);
        assert.deepEqual(row("explicit-shared-enabled-path").bodies, []);
      },
    ],
    [
      "线程和进程级 skip 开关未隐藏本地资源",
      () => {
        for (const name of [
          "thread-skip-host-explicit-shared",
          "thread-skip-host-explicit-home",
          "process-skip-host-explicit-shared",
        ])
          assert(row(name).currentCatalog.includes("DESC_probe-b"));
      },
    ],
    [
      "按路径禁用会阻止显式入口加载",
      () => assert.deepEqual(row("disabled-b-explicit-invocation").bodies, []),
    ],
    [
      "仅显式调用策略隐藏清单，但用户仍能点名加载",
      () => {
        assert(!row("implicit-policy-catalog").currentCatalog.includes("DESC_probe-explicit-only"));
        assert(row("implicit-policy-user-mention").bodies.includes("BODY_probe-explicit-only"));
      },
    ],
    [
      "完整枚举后两个线程分别加载各自 Skill",
      () => {
        assert.deepEqual(row("enumerated-whitelist-a").currentCatalog, ["DESC_probe-a"]);
        assert.deepEqual(row("enumerated-whitelist-b").currentCatalog, ["DESC_probe-b"]);
        assert.deepEqual(row("enumerated-whitelist-a").details, ["DETAIL_probe-shared-a"]);
        assert.deepEqual(row("enumerated-whitelist-b").details, ["DETAIL_probe-shared-b"]);
      },
    ],
    [
      "API 示例读取函数拒绝跨线程资源",
      () =>
        assert(
          result.toolCalls.some(
            (entry) =>
              entry.threadId === threadA && entry.skill === outsideB.name && !entry.allowed,
          ),
        ),
    ],
    [
      "共享目录新增资源进入旧线程清单和正文",
      () => {
        assert(row("old-thread-after-new-skill").currentCatalog.includes("DESC_probe-new-c"));
        assert(row("old-thread-invoke-new-skill").bodies.includes("BODY_probe-new-c"));
      },
    ],
    [
      "重启恢复旧枚举仍能发现新增资源",
      () => assert(row("resume-old-enumeration").currentCatalog.includes("DESC_probe-new-c")),
    ],
    [
      "恢复时重新枚举可限制当前清单，但保留原历史",
      () => {
        assert.deepEqual(row("resume-refreshed-enumeration").currentCatalog, ["DESC_probe-a"]);
        assert(row("resume-refreshed-enumeration").bodies.includes("BODY_probe-b"));
      },
    ],
  ];
  result.checks = [];
  for (const [name, check] of checks) {
    check();
    result.checks.push({ name, passed: true });
  }
  console.log(`PASS: ${result.checks.length} behavior checks; ${result.cases.length} scenarios`);
} catch (error) {
  result.error = String(error.stack ?? error);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await client?.close();
  await new Promise((done) => server.close(done));
  result.requests = captures;
  const evidence = join(
    dirname(fileURLToPath(import.meta.url)),
    "skill-allowlist-probe.result.json",
  );
  await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`);
  assert.equal(dirname(resolve(root)), parent, "Probe cleanup must remain in its dedicated parent");
  await rm(root, { recursive: true, force: true });
  console.log(`Evidence: ${evidence}`);
}
