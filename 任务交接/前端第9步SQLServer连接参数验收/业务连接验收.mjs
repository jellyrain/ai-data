import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// 使用当前源码装配真实服务。业务库只读，所有管理写入进入随机临时元数据库。
const workspace = fileURLToPath(new URL("../../ai-data/", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
const apiRequire = createRequire(join(workspace, "apps/api/package.json"));
const webRequire = createRequire(join(workspace, "apps/web/package.json"));
const { SqlServerMetadataDatabase } = await import(
  pathToFileURL(apiRequire.resolve("@ai-data/metadata/sqlserver"))
);
const { build } = apiRequire("esbuild");
const { chromium, expect } = webRequire("@playwright/test");
const dayjs = webRequire("dayjs");
const config = JSON.parse(
  await readFile(join(workspace, "apps/api/config/api.config.json"), "utf8"),
);
const connection = config.metadata_sqlserver;
const root = await mkdtemp(join(tmpdir(), "ai-data-transport-live-"));
const prefix = "ai_data_transport_live_" + randomUUID().replaceAll("-", "");
const processes = [],
  databases = [];
const result = {
  started_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
  environment: "isolated",
  business_database: "ai_bi_demo",
  checks: [],
  queries: [],
};
let master,
  apiDb,
  business,
  browser,
  phase = "prepare",
  activePage;
const password = "Isolated-browser-2026!";
const save = () => writeFile(join(evidence, "验收结果.json"), JSON.stringify(result, null, 2));
const check = async (name, detail = {}) => {
  result.checks.push({ name, passed: true, ...detail });
  await save();
  console.log(name);
};
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
async function wait(checker, label, ms = 45000) {
  const until = dayjs().valueOf() + ms;
  while (dayjs().valueOf() < until) {
    if (await checker()) return;
    await delay(500);
  }
  throw new Error(label + "超时");
}
function launch(cwd, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 子进程原始日志仅保存在内存，错误交付也只写脱敏尾部。
  const entry = { child, log: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      entry.log = (entry.log + chunk).slice(-16000);
    });
  processes.push(entry);
  return entry;
}
async function stop(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const exited = once(entry.child, "exit");
  await promisify(execFile)("taskkill", ["/PID", String(entry.child.pid), "/T", "/F"], {
    windowsHide: true,
    timeout: 5000,
  }).catch(() => {
    entry.child.kill();
  });
  await Promise.race([exited, delay(5000)]);
  assert(entry.child.exitCode !== null || entry.child.signalCode !== null, "隔离子进程未退出");
}

async function json(base, path, method = "GET", body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(
      `${method} ${path}: HTTP ${response.status} ${value.code ?? ""} ${value.message ?? ""}`,
    );
    error.status = response.status;
    throw error;
  }
  return value;
}
async function choose(page, label, value) {
  const input = page.getByRole("combobox", { name: label, exact: true });
  await input.scrollIntoViewIfNeeded();
  if ((await input.getAttribute("aria-expanded")) !== "true")
    await input.locator("xpath=ancestor::*[contains(@class, 'el-select__wrapper')]").click();
  const controls = await input.getAttribute("aria-controls");
  await page
    .locator(`[id="${controls}"]`)
    .getByRole("option", { name: value, exact: true })
    .click();
  await page.getByRole("heading").first().click();
}
async function login(page, base, username) {
  await page.goto(base + "/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
}
const source = "management-demo",
  service = "management-das";
try {
  master = await SqlServerMetadataDatabase.connect({
    ...connection,
    database: "master",
  });
  for (const app of ["api", "das"]) {
    const name = prefix + "_" + app;
    await master.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    databases.push(name);
    const appRoot = join(root, app);
    await mkdir(join(appRoot, "config"), { recursive: true });
    await mkdir(join(appRoot, "dist"));
    await mkdir(join(appRoot, "secrets"));
    const from = join(workspace, "apps", app === "api" ? "api" : "data-access");
    await cp(join(from, "migrations"), join(appRoot, "migrations"), {
      recursive: true,
    });
    await symlink(join(from, "node_modules"), join(appRoot, "node_modules"), "junction");
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}');
    await build({
      entryPoints: [join(from, "src/index.ts")],
      bundle: true,
      minify: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: app === "api" ? ["@openai/codex-sdk"] : ["oracledb"],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      outfile: join(appRoot, "dist/index.js"),
      logLevel: "silent",
    });
  }
  const apiPort = await port(),
    dasPort = await port(),
    webPort = await port();
  const apiBase = `http://127.0.0.1:${apiPort}`,
    dasBase = `http://127.0.0.1:${dasPort}`,
    webBase = `http://127.0.0.1:${webPort}`;
  const apiRoot = join(root, "api"),
    dasRoot = join(root, "das");
  const isolated = {
    ...config,
    node_env: "test",
    service: { ...config.service, host: "127.0.0.1", port: apiPort },
    metadata_sqlserver: { ...connection, database: databases[0] },
    bootstrap_admin: {
      organization_id: "management-org",
      organization_code: "management",
      organization_name: "联合管理验收",
      username: "management-admin",
      display_name: "验收管理员",
      password,
    },
    trusted_data_access_services: [{ service_id: service, credential_version: 1, enabled: true }],
    analysis_runtime: {
      enabled: false,
      state_directory: join(apiRoot, "secrets/runtime"),
      skills_directory: join(workspace, "packages/skills"),
      concurrency: 1,
      poll_ms: 100,
    },
    jwt: {
      issuer: "management-test",
      audience: "management-test",
      access_token_ttl_seconds: 3600,
      key_directory: join(apiRoot, "secrets"),
    },
  };
  await writeFile(join(apiRoot, "config/api.config.json"), JSON.stringify(isolated));
  phase = "API 启动";
  const api = launch(apiRoot, ["dist/index.js"]);
  await wait(
    async () =>
      fetch(apiBase + "/health")
        .then((r) => r.ok)
        .catch(() => false),
    "API 启动",
  );
  const token = (
    await json(apiBase, "/auth/login", "POST", {
      username: "management-admin",
      password,
    })
  ).accessToken;
  const call = (path, method = "GET", body) => json(apiBase, path, method, body, token);
  const credential = await call(`/admin/data-access/services/${service}/credential`, "POST");
  await writeFile(join(dasRoot, "secrets/api-registration.jwt"), credential.credential);
  await cp(join(apiRoot, "secrets/jwt-public.pem"), join(dasRoot, "secrets/api-public.pem"));
  const dasConfig = JSON.parse(
    await readFile(join(workspace, "apps/data-access/config/das.config.example.json"), "utf8"),
  );
  dasConfig.service = {
    ...dasConfig.service,
    host: "127.0.0.1",
    port: dasPort,
    service_id: service,
  };
  dasConfig.metadata_sqlserver = { ...connection, database: databases[1] };
  dasConfig.api = {
    ...dasConfig.api,
    base_url: apiBase,
    jwt_verification_public_key_path: "../secrets/api-public.pem",
  };
  dasConfig.sqlserver_transports = {
    [source]: {
      encrypt: false,
      trust_server_certificate: true,
    },
  };
  await writeFile(join(dasRoot, "config/das.config.json"), JSON.stringify(dasConfig));
  phase = "DAS 接入";
  let das = launch(dasRoot, ["dist/index.js"]);
  await wait(
    async () =>
      fetch(dasBase + "/health")
        .then((r) => r.ok)
        .catch(() => false),
    "DAS 启动",
  );
  await wait(
    async () =>
      (await call("/admin/data-access/services")).items.some((s) => s.service_id === service),
    "DAS 注册",
  );
  const manage = (path, method = "GET", body) =>
    call(`/admin/data-access/services/${service}/${path}`, method, body);
  await manage("data-source-secrets", "POST", {
    secret_ref: "business-read",
    connector_kind: "sqlserver",
    host: connection.server,
    port: connection.port,
    user: connection.user,
    password: connection.password,
  });
  await manage("data-sources", "PUT", {
    source_id: source,
    connector_kind: "sqlserver",
    secret_ref: "business-read",
    target_database: "ai_bi_demo",
    timeout_ms: 30000,
    connection_pool_limit: 2,
    concurrency_limit: 2,
    row_limit: 1000,
  });

  phase = "信任关闭时证书错误";
  await assert.rejects(
    manage("database-targets", "POST", {
      secret_ref: "business-read",
      connector_kind: "sqlserver",
    }),
    (error) => error.status === 503 && /DATA_SOURCE_CERTIFICATE_INVALID/.test(error.message),
  );
  await check("信任关闭时返回脱敏证书错误");
  const optionsPath = "data-source-secrets/business-read/sqlserver-transport";
  const baseline = await manage(optionsPath);
  assert.equal(baseline.origin, "default");
  assert.equal(baseline.sources[0].origin, "deployment");
  assert.deepEqual(baseline.sources[0].sqlserver_transport, {
    encrypt: false,
    trust_server_certificate: true,
  });
  phase = "浏览器修改业务连接参数";
  launch(
    join(workspace, "apps/web"),
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    { WEB_API_TARGET: apiBase },
  );
  await wait(
    () =>
      fetch(webBase)
        .then((r) => r.ok)
        .catch(() => false),
    "Web 启动",
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  activePage = page;
  page.setDefaultTimeout(20000);
  await login(page, webBase, "management-admin");
  await page.goto(webBase + "/settings/data");
  await choose(page, "DAS 实例", service + " · 在线");
  await page.getByRole("button", { name: "保存数据库凭据", exact: true }).click();
  const editor = page.getByRole("region", { name: "已有凭据连接参数" });
  await choose(page, "连接参数凭据", "business-read");
  await expect(editor.getByText(/尚未在 Web 设置/)).toBeVisible();
  await editor
    .locator(".el-switch")
    .filter({ has: page.getByRole("switch", { name: "信任服务器证书", exact: true }) })
    .locator(".el-switch__core")
    .click();
  await editor.getByRole("button", { name: "保存连接参数", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor.getByText(/连接参数已保存并回读/)).toBeVisible();
  const saved = await manage(optionsPath);
  assert.deepEqual(saved.sqlserver_transport, { encrypt: true, trust_server_certificate: true });
  assert(saved.sources.every((source) => source.origin === "credential"));
  assert.deepEqual(
    Object.keys(saved).sort(),
    ["connector_kind", "origin", "revision", "secret_ref", "sources", "sqlserver_transport"].sort(),
  );
  await check("真实 Web 保存、回读与凭据级覆盖旧文件设置");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ["亮色", "暗色"]) {
      await page.getByRole("button", { name: "外观设置" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: "外观设置" }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await editor.screenshot({ path: join(evidence, "连接参数-" + width + "-" + mode + ".png") });
    }
  }
  await check("连接参数亮暗主题与三种宽度检查");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /management-demo management-demo 启用/ }).click();
  await page.getByRole("button", { name: "使用凭据发现目标库", exact: true }).click();
  await expect(page.getByText(/已发现 .* 个目标/)).toBeVisible();
  const targets = await manage("database-targets", "POST", {
    secret_ref: "business-read",
    connector_kind: "sqlserver",
  });
  assert(targets.databases.some((row) => row.name === "ai_bi_demo"));
  await check("浏览器目标库发现恢复，目标包含 ai_bi_demo");
  const discovered = await manage("data-source-objects/discover", "POST", { source_id: source });
  assert(discovered.items.some((row) => row.object_id === "table.dbo.admissions"));
  await check("对象发现使用已保存业务连接参数", { object_count: discovered.items.length });
  const white = await manage("data-source-objects/" + source);
  await manage("data-source-objects", "PUT", {
    source_id: source,
    expected_revision: white.revision,
    objects: [{ object_id: "table.dbo.admissions" }],
  });
  await stop(das);
  das = launch(dasRoot, ["dist/index.js"]);
  await wait(
    async () =>
      fetch(dasBase + "/health")
        .then((r) => r.ok)
        .catch(() => false),
    "DAS 重启",
  );
  await wait(
    async () =>
      (await call("/admin/data-access/services")).items.some((s) =>
        s.sources.some((v) => v.source_id === source && v.status === "healthy"),
      ),
    "数据源心跳",
  );
  assert.deepEqual((await manage(optionsPath)).sqlserver_transport, saved.sqlserver_transport);
  await call("/admin/catalog/datasets", "PUT", {
    source_id: source,
    object_id: "table.dbo.admissions",
    expected_version: 0,
    business_description: "验收住院记录",
    grain: "每行一次住院",
    unique_keys: [["admission_id"]],
    approved_relations: [],
    column_descriptions: [],
    column_policies: [],
  });
  business = await SqlServerMetadataDatabase.connect({ ...connection, database: "ai_bi_demo" });
  const expected = (
    await business.execute({
      sql: "SELECT COUNT(*) AS admissions FROM dbo.admissions",
      parameters: [],
    })
  ).rows[0].admissions;
  const query = {
    type: "relational_query",
    source_id: source,
    from: { object_id: "table.dbo.admissions", alias: "a" },
    select: [{ field: "a.admission_id", aggregation: "count", as: "admissions" }],
    limit: 1,
  };
  const actual = await call("/query", "POST", query);
  assert.equal(Number(actual.rows[0].admissions), Number(expected));
  result.queries.push({ name: "全库住院人次", expected, actual: actual.rows[0].admissions });
  await check("DAS 重启后参数持久化，业务只读查询与数据库基准一致");
  const storedConfig = JSON.parse(await readFile(join(dasRoot, "config/das.config.json"), "utf8"));
  assert.deepEqual(storedConfig.metadata_sqlserver, { ...connection, database: databases[1] });
  assert.deepEqual(
    JSON.parse(await readFile(join(workspace, "apps/api/config/api.config.json"), "utf8")),
    config,
  );
  await check("DAS 元数据库连接保持独立，项目运行配置保持原值");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  const safe = [connection.password, connection.user, password]
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(error.message));
  if (activePage)
    result.ui = await activePage
      .locator("input,button,h1,h2,h3,.el-alert__description")
      .evaluateAll((elements) =>
        elements.map((e) => ({
          tag: e.tagName,
          type: e.type,
          role: e.getAttribute("role"),
          aria: e.getAttribute("aria-label"),
          text: e.tagName === "INPUT" ? undefined : e.textContent,
        })),
      );
  const logs = processes
    .map((entry) =>
      [connection.password, connection.user, password]
        .filter(Boolean)
        .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), entry.log),
    )
    .join("\n");
  result.failure = { phase, message: safe, diagnostic: logs };
  console.log("验收失败：" + phase + " " + safe);
  process.exitCode = 1;
} finally {
  result.status_before_cleanup = result.status;
  result.cleanup_phase = "browser";
  await save();
  await browser?.close();
  result.cleanup_phase = "processes";
  await save();
  for (const entry of [...processes].reverse()) await stop(entry);
  result.cleanup_phase = "databases";
  await save();
  await business?.close();
  await apiDb?.close();
  for (const name of [...databases].reverse()) {
    assert(/^ai_data_transport_live_[a-f0-9]{32}_(api|das)$/.test(name));
    await master.execute({
      sql: `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]`,
      parameters: [],
    });
  }
  await master?.close();
  result.cleanup_phase = "directory";
  await save();
  assert(
    resolve(root).startsWith(resolve(tmpdir()) + sep) &&
      basename(root).startsWith("ai-data-transport-live-"),
  );
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  result.cleanup_phase = "complete";
  result.cleaned_up = true;
  result.finished_at = dayjs().format("YYYY-MM-DD HH:mm:ss");
  await save();
}
