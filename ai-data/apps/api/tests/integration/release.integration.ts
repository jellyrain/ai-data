import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import type { SubmittedMessage } from "../../src/conversations/conversation-types";
import { toolInputs } from "../../src/runtime/tool-contracts";
import { readDialogueConnection } from "./dialogue-das-fixture";

/** 独立发布验收使用真实官方进程、HTTP 和 SQL；本机协议夹具让模型响应可重复。 */
it("独立发布包完成首建、注册、查询和官方线程恢复，程序更新保留实例状态", async () => {
  const source = fileURLToPath(
    new URL(`../../../../release/${process.platform}-${process.arch}/`, import.meta.url),
  );
  const root = await mkdtemp(join(tmpdir(), "ai-data-release-"));
  const prefix = `ai_data_release_test_${randomUUID().replaceAll("-", "")}`;
  const connection = apiConfigSchema.shape.metadata_sqlserver.parse(readDialogueConnection());
  const databases: { name: string; database?: SqlServerMetadataDatabase }[] = [];
  const processes: ReturnType<typeof startProcess>[] = [];
  const payloads: Record<string, unknown>[] = [];
  const authorizations: (string | undefined)[] = [];
  const query = {
    type: "relational_query",
    source_id: "release",
    from: { object_id: "table.dbo.release_visits", alias: "v" },
    select: [{ field: "v.visit_id", aggregation: "count_distinct", as: "visits" }],
  };
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    payloads.push(JSON.parse(body) as Record<string, unknown>);
    authorizations.push(request.headers.authorization);
    const number = payloads.length;
    const args =
      number === 1
        ? { skill_name: "query-dsl", relative_path: "references/relational-query.md" }
        : { query };
    const text = number === 3 ? "发布查询完成，共 3 人次。" : "沿用上次查询结果，共 3 人次。";
    const item =
      number <= 2
        ? {
            type: "function_call",
            id: `fc-${number}`,
            call_id: `call-${number}`,
            name: number === 1 ? "read_skill_reference" : "query_dataset",
            arguments: JSON.stringify(args),
          }
        : {
            type: "message",
            id: `message-${number}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, fields: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", {
      response: { id: `resp-${number}`, status: "in_progress", output: [] },
    });
    emit("response.output_item.added", {
      output_index: 0,
      item: number <= 2 ? { ...item, arguments: "" } : { ...item, content: [] },
    });
    emit(number <= 2 ? "response.function_call_arguments.delta" : "response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      ...(number <= 2 ? {} : { content_index: 0 }),
      delta: number <= 2 ? JSON.stringify(args) : text,
    });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        id: `resp-${number}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020 },
      },
    });
    response.end();
  });
  let admin: SqlServerMetadataDatabase | undefined;
  try {
    await copyProgram(join(source, "api"), join(root, "api"), "api");
    await copyProgram(join(source, "das"), join(root, "das"), "das");
    // 发布内容必须是普通文件，确保临时实例不能沿链接回到工作区。
    for (const [app, dependency] of [
      ["api", "@openai/codex-sdk"],
      ["das", "oracledb"],
    ]) {
      const directory = join(root, app);
      await assertRegularTree(directory);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.stdout.write(import.meta.resolve(${JSON.stringify(dependency)}));`,
        ],
        { cwd: directory, env: isolatedEnvironment(), windowsHide: true, timeout: 10000 },
      );
      assert(fileURLToPath(stdout).startsWith(join(directory, "node_modules") + sep));
    }
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const modelAddress = model.address();
    assert(modelAddress && typeof modelAddress !== "string");
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    for (const suffix of ["api", "das"]) {
      const name = `${prefix}_${suffix}`;
      await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
      const entry: (typeof databases)[number] = { name };
      databases.push(entry);
      entry.database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    }
    const apiDatabase = databases[0].database!;
    const dasDatabase = databases[1].database!;
    await dasDatabase.execute({
      sql: "CREATE TABLE dbo.release_visits (visit_id INT NOT NULL); INSERT INTO dbo.release_visits VALUES (1),(2),(2),(3);",
      parameters: [],
    });
    const apiPort = await availablePort(),
      dasPort = await availablePort();
    const apiRoot = join(root, "api"),
      dasRoot = join(root, "das");
    const apiBase = `http://127.0.0.1:${apiPort}`,
      dasBase = `http://127.0.0.1:${dasPort}`;
    const apiConfig = apiConfigSchema.parse(
      JSON.parse(await readFile(join(apiRoot, "config/api.config.example.json"), "utf8")),
    );
    apiConfig.service = { ...apiConfig.service, host: "127.0.0.1", port: apiPort };
    apiConfig.metadata_sqlserver = { ...connection, database: databases[0].name };
    apiConfig.bootstrap_admin = {
      organization_id: "release-org",
      organization_code: "release",
      organization_name: "发布验收",
      username: "release-admin",
      display_name: "发布管理员",
      password: "test-password-only",
    };
    apiConfig.trusted_data_access_services = [
      { service_id: "release-das", credential_version: 1, enabled: true },
    ];
    apiConfig.analysis_runtime = {
      ...apiConfig.analysis_runtime!,
      enabled: true,
      poll_ms: 100,
      concurrency: 1,
    };
    await writeFile(join(apiRoot, "config/api.config.json"), JSON.stringify(apiConfig), {
      mode: 0o600,
    });
    const launch = (directory: string) => {
      const process = startProcess(directory, [
        connection.password,
        connection.user,
        connection.server,
      ]);
      processes.push(process);
      return process;
    };
    let api = launch(apiRoot);
    await api.ready(apiBase);
    const login = await requestJson<{ accessToken: string }>(apiBase, "/auth/login", "POST", {
      username: "release-admin",
      password: "test-password-only",
    });
    const token = login.accessToken;
    const call = <T>(path: string, method = "GET", body?: unknown) =>
      requestJson<T>(apiBase, path, method, body, token);
    expect(await call("/models")).toEqual({ items: [] });
    expect(await call("/agents")).toEqual({ items: [] });
    await call("/models", "POST", {
      model_id: "release-model",
      version: 1,
      name: "发布模型",
      protocol: "responses",
      model: "release-fixture",
      base_url: `http://127.0.0.1:${modelAddress.port}/v1`,
      api_key: "release-test-key",
      context_window: 32768,
    });
    await call("/agents", "POST", {
      agent_id: "default",
      version: 1,
      name: "发布助手",
      model_id: "release-model",
      model_version: 1,
      instructions: "通过已提供的业务函数查询授权数据，依据证据回答。",
      tool_names: Object.keys(toolInputs),
      skill_names: ["query-analysis", "query-dsl"],
      limits: { timeout_ms: 30000, max_tool_calls: 30, max_context_bytes: 65536 },
    });
    const credential = await call<{ credential: string }>(
      "/admin/data-access/services/release-das/credential",
      "POST",
    );
    await mkdir(join(dasRoot, "secrets"));
    await cp(join(apiRoot, "secrets/jwt-public.pem"), join(dasRoot, "secrets/api-public.pem"));
    await writeFile(join(dasRoot, "secrets/api-registration.jwt"), credential.credential, {
      mode: 0o600,
    });
    const dasConfig = JSON.parse(
      await readFile(join(dasRoot, "config/das.config.example.json"), "utf8"),
    );
    dasConfig.service = {
      ...dasConfig.service,
      host: "127.0.0.1",
      port: dasPort,
      service_id: "release-das",
    };
    dasConfig.api.base_url = apiBase;
    dasConfig.metadata_sqlserver = { ...connection, database: databases[1].name };
    dasConfig.sqlserver_transports = {
      release: {
        encrypt: connection.options.encrypt,
        trust_server_certificate: connection.options.trust_server_certificate,
      },
    };
    await writeFile(join(dasRoot, "config/das.config.json"), JSON.stringify(dasConfig), {
      mode: 0o600,
    });
    let das = launch(dasRoot);
    await das.ready(dasBase);
    const waitRegistration = (withSource: boolean) =>
      waitFor(async () => {
        const services = await call<{
          items: { service_id: string; sources: { source_id: string; status: string }[] }[];
        }>("/internal/data-access/services");
        return services.items.some(
          (s) =>
            s.service_id === "release-das" &&
            (!withSource ||
              s.sources.some((v) => v.source_id === "release" && v.status === "healthy")),
        );
      }, "DAS 注册或健康数据源未就绪");
    await waitRegistration(false);
    const manage = (operation: string, method: string, body: unknown) =>
      call(`/admin/data-access/services/release-das/${operation}`, method, body);
    await manage("data-source-secrets", "POST", {
      secret_ref: "release",
      connector_kind: "sqlserver",
      host: connection.server,
      port: connection.port,
      user: connection.user,
      password: connection.password,
    });
    await manage("data-sources", "PUT", {
      source_id: "release",
      connector_kind: "sqlserver",
      secret_ref: "release",
      target_database: databases[1].name,
      timeout_ms: 10000,
      connection_pool_limit: 2,
      concurrency_limit: 2,
      row_limit: 100,
    });
    await manage("data-source-objects", "PUT", {
      source_id: "release",
      objects: [{ object_id: "table.dbo.release_visits" }],
    });
    await das.close();
    das = launch(dasRoot);
    await das.ready(dasBase);
    await waitRegistration(true);
    expect(await call("/query", "POST", query)).toMatchObject({ rows: [{ visits: 3 }] });
    const conversation = await call<{ id: string }>("/conversations", "POST", {
      title: "发布验收会话",
    });
    const run = async (content: string) => {
      const submitted = await call<SubmittedMessage>(
        `/conversations/${conversation.id}/messages`,
        "POST",
        { content, idempotency_key: randomUUID() },
      );
      let state: { status: string; error?: unknown } | undefined;
      await waitFor(
        async () => {
          state = await call(`/analysis-runs/${submitted.analysisRun.id}`);
          return ["completed", "failed", "cancelled", "waiting_for_input"].includes(state!.status);
        },
        "发布产物分析未完成",
        45000,
      );
      expect(state).toMatchObject({ status: "completed" });
      return submitted.analysisRun.id;
    };
    const firstRun = await run("先读查询 Skill 子文档，再查询就诊总人次。");
    expect(payloads).toHaveLength(3);
    expect(JSON.stringify(payloads[0].input)).toContain(
      "将业务问题转换为 API 工具可接收的结构化查询 DSL",
    );
    const reference = await readFile(
      join(apiRoot, "skills/query-dsl/references/relational-query.md"),
      "utf8",
    );
    // 函数结果以 JSON 字符串进入协议，逐层解析后核对实际子文档全文。
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
    expect(
      strings(payloads[1].input).some((value) =>
        value.includes(JSON.stringify(reference).slice(1, -1)),
      ),
    ).toBe(true);
    const evidence = await call<{ items: { result: { rows: unknown[] } }[] }>(
      `/analysis-runs/${firstRun}/evidence`,
    );
    expect(evidence.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: expect.objectContaining({ rows: [{ visits: 3 }] }) }),
      ]),
    );
    const threads = () =>
      apiDatabase.execute<{ thread_id: string }>({
        sql: "SELECT thread_id FROM dbo.analysis_codex_threads",
        parameters: [],
      });
    const beforeThreads = await threads();
    expect(beforeThreads.rows).toHaveLength(1);
    const audits = () =>
      dasDatabase.execute<{ outcome: string }>({
        sql: "SELECT outcome FROM dbo.query_audit_logs",
        parameters: [],
      });
    expect((await audits()).rows).toEqual([{ outcome: "executed" }, { outcome: "executed" }]);
    await api.close();
    await das.close();
    const preserved = [
      "api/config/api.config.json",
      "das/config/das.config.json",
      "api/secrets/jwt-private.pem",
      "api/secrets/jwt-public.pem",
      "das/secrets/api-registration.jwt",
    ];
    const hashes = async () =>
      Promise.all(
        preserved.map(async (path) =>
          createHash("sha256")
            .update(await readFile(join(root, path)))
            .digest("hex"),
        ),
      );
    const beforeHashes = await hashes();
    const apiState = await treeHashes(join(apiRoot, "secrets"));
    const dasState = await treeHashes(join(dasRoot, "secrets"));
    expect([...apiState.keys()].some((path) => path.includes("model-keys"))).toBe(true);
    expect([...apiState.keys()].some((path) => path.endsWith("relational-query.md"))).toBe(true);
    // 按部署说明覆盖程序资源；实际配置和状态从原实例继续使用。
    await copyProgram(join(source, "api"), apiRoot, "api");
    await copyProgram(join(source, "das"), dasRoot, "das");
    expect(await hashes()).toEqual(beforeHashes);
    expect(await treeHashes(join(apiRoot, "secrets"))).toEqual(apiState);
    expect(await treeHashes(join(dasRoot, "secrets"))).toEqual(dasState);
    api = launch(apiRoot);
    await api.ready(apiBase);
    das = launch(dasRoot);
    await das.ready(dasBase);
    await waitRegistration(true);
    await run("沿用上次的查询结果说明总人次。");
    expect(payloads).toHaveLength(4);
    expect(authorizations).toEqual(Array(4).fill("Bearer release-test-key"));
    expect(await call("/models")).toMatchObject({
      items: [{ model_id: "release-model", version: 1 }],
    });
    expect(await threads()).toEqual(beforeThreads);
    expect(JSON.stringify(payloads[3].input)).toContain("发布查询完成，共 3 人次。");
    expect((await audits()).rows).toHaveLength(2);
    expect(await hashes()).toEqual(beforeHashes);
  } finally {
    for (const process of [...processes].reverse()) await process.close();
    model.closeAllConnections();
    if (model.listening)
      await new Promise<void>((done, reject) =>
        model.close((error) => (error ? reject(error) : done())),
      );
    try {
      for (const entry of [...databases].reverse()) {
        await entry.database?.close();
        assert.match(entry.name, /^ai_data_release_test_[a-f0-9]{32}_(api|das)$/);
        await admin?.execute({ sql: `DROP DATABASE [${entry.name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert(basename(root).startsWith("ai-data-release-"));
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}, 150000);

/** 首次部署和程序更新均按发布文件清单复制，来源目录中的实例配置和状态不属于程序包。 */
async function copyProgram(source: string, destination: string, app: "api" | "das") {
  const paths = [
    "dist",
    "node_modules",
    "migrations",
    "package.json",
    "release-info.json",
    `config/${app}.config.example.json`,
    ...(app === "api" ? ["skills"] : []),
  ];
  await mkdir(join(destination, "config"), { recursive: true });
  for (const path of paths)
    await cp(join(source, path), join(destination, path), { recursive: true });
}

/** 子进程只使用发布目录及系统 Node，不继承开发配置或 Node 加载钩子。 */
function startProcess(directory: string, secrets: string[]) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: directory,
    env: isolatedEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => {
    const summary = chunk
      .toString()
      .split("\n")
      .filter((line) => line.length < 1000)
      .join("\n");
    error = (
      error +
      secrets.filter(Boolean).reduce((text, value) => text.replaceAll(value, "[redacted]"), summary)
    ).slice(-1500);
  });
  const exited = once(child, "exit");
  return {
    ready: (base: string) =>
      waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`发布进程提前退出：${error}`);
        try {
          const health = await fetch(base + "/health", { signal: AbortSignal.timeout(500) });
          await health.body?.cancel();
          return health.ok;
        } catch {
          return false;
        }
      }, "发布进程未就绪"),
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Windows 终止 Node 不会同步结束它的原生子进程；只清理本夹具启动的进程树。
      if (process.platform === "win32" && child.pid) {
        try {
          await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 10000,
          });
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) throw error;
        }
      } else child.kill();
      await exited;
    },
  };
}
function isolatedEnvironment() {
  const env = { ...process.env };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "API_CONFIG_PATH"]) delete env[key];
  return env;
}
async function requestJson<T>(
  base: string,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert(
    response.ok,
    `HTTP ${method} ${path}: ${response.status}, code=${result.code ?? result.error?.code ?? "unknown"}`,
  );
  return result as T;
}
async function waitFor(check: () => Promise<boolean>, message: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error(message);
}
async function availablePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function assertRegularTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `发布文件不能是链接：${entry.name}`);
    if (entry.isDirectory()) await assertRegularTree(join(directory, entry.name));
  }
}
async function treeHashes(directory: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      key = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      for (const [name, hash] of await treeHashes(path, `${key}/`)) result.set(name, hash);
    else
      result.set(
        key,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
  }
  return result;
}
