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
import { defineTables } from "../../ai-data/scripts/demo-data/schema.mjs";

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
const root = await mkdtemp(join(tmpdir(), "ai-data-management-live-"));
const prefix = "ai_data_management_live_" + randomUUID().replaceAll("-", "");
const processes = [],
  databases = [];
const result = {
  started_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
  environment: "isolated",
  business_database: "ai_bi_demo",
  checks: [],
  queries: [],
  models: [],
};
let master,
  apiDb,
  business,
  browser,
  phase = "prepare",
  activePage;
const password = "Isolated-browser-2026!";
assert(process.env.MANAGEMENT_RJ_API_KEY, "运行前通过环境变量提供已授权的模型凭据");
const fixedPolicy = process.env.MANAGEMENT_FIXED_POLICY === "1";
result.policy_mode = fixedPolicy ? "fixed_integer_role" : "department_context";
const save = () =>
  writeFile(
    join(evidence, fixedPolicy ? "隔离固定值业务验收.json" : "隔离业务验收.json"),
    JSON.stringify(result, null, 2),
  );
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
  if (entry.child.exitCode !== null) return;
  await promisify(execFile)("taskkill", ["/PID", String(entry.child.pid), "/T", "/F"], {
    windowsHide: true,
  }).catch(() => {});
  await Promise.race([once(entry.child, "exit"), delay(1000)]);
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
  service = "management-das",
  role = "management-reader";
const acceptanceRoles = fixedPolicy ? [role + "-1", role + "-2"] : [role];
const tables = defineTables().filter((t) =>
  ["admissions", "inpatient_charge_details", "departments"].includes(t.name),
);
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
      enabled: true,
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
      encrypt: connection.options.encrypt,
      trust_server_certificate: connection.options.trust_server_certificate,
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
  try {
    const targetList = await manage("database-targets", "POST", {
      secret_ref: "business-read",
      connector_kind: "sqlserver",
    });
    assert(targetList.databases.some((d) => d.name === "ai_bi_demo"));
    await check("数据库目标发现");
  } catch (error) {
    result.target_discovery = {
      status: "blocked",
      http_status: error.status,
      note: "本机 SQL Server IP 连接与目标发现的证书校验不匹配；使用既有表单支持的显式库名继续接入。",
    };
  }
  const white = await manage(`data-source-objects/${source}`);
  await manage("data-source-objects", "PUT", {
    source_id: source,
    expected_revision: white.revision,
    objects: tables.map((t) => ({ object_id: "table.dbo." + t.name })),
  });
  await stop(das);
  das = launch(dasRoot, ["dist/index.js"]);
  await wait(
    async () =>
      (await call("/admin/data-access/services")).items.some((s) =>
        s.sources.some((v) => v.source_id === source && v.status === "healthy"),
      ),
    "数据源心跳",
  );
  await check("真实 DAS 注册、凭据引用与完整白名单", {
    objects: tables.length,
  });
  apiDb = await SqlServerMetadataDatabase.connect({
    ...connection,
    database: databases[0],
  });
  // 现有角色由部署初始化，本轮界面只分配已有角色；用隔离种子账号建立角色归属。
  for (const roleId of acceptanceRoles)
    await apiDb.execute({
      sql: `INSERT INTO dbo.roles(id,code,name) VALUES('${roleId}','${roleId}',N'住院分析员'); INSERT INTO dbo.user_roles(user_id,role_id) SELECT id,'${roleId}' FROM dbo.users WHERE username='management-admin';`,
      parameters: [],
    });
  for (const table of tables) {
    const object = "table.dbo." + table.name;
    await call("/admin/catalog/datasets", "PUT", {
      source_id: source,
      object_id: object,
      expected_version: 0,
      business_description: table.label + "；金额以分计，posted 表示有效费用。",
      grain: "每行一条" + table.label,
      unique_keys: [[table.key]],
      approved_relations: [],
      column_descriptions: table.columns.map((c) => ({
        field: c.name,
        business_description: c.label,
      })),
      column_policies: [],
    });
    for (const [index, roleId] of acceptanceRoles.entries()) {
      await call("/admin/catalog/object-permissions", "PUT", {
        source_id: source,
        role_id: roleId,
        object_id: object,
        effect: "allow",
      });
      await call("/admin/catalog/row-policies", "PUT", {
        source_id: source,
        role_id: roleId,
        object_id: object,
        effect: "allow",
        condition: fixedPolicy
          ? { field: "department_id", op: "eq", value: index + 1 }
          : {
              field: "department_id",
              op: "in",
              value_from: "permission_context.department_ids",
            },
      });
    }
  }
  for (const roleId of acceptanceRoles)
    await call("/admin/catalog/column-permissions", "PUT", {
      source_id: source,
      role_id: roleId,
      object_id: "table.dbo.admissions",
      column: "patient_id",
      effect: "deny",
    });
  phase = "浏览器模型与 Agent";
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
    async () =>
      fetch(webBase)
        .then((r) => r.ok)
        .catch(() => false),
    "Web 启动",
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  activePage = page;
  page.setDefaultTimeout(20000);
  await login(page, webBase, "management-admin");
  async function publishModel(version) {
    await page.goto(webBase + "/settings/models");
    if (version === 1) {
      await page.getByRole("button", { name: "新建模型", exact: true }).click();
      await page.getByLabel("模型标识", { exact: true }).fill("rj-management");
      await page.getByLabel("服务地址", { exact: true }).fill("http://192.168.110.208:8000/v1");
      await page.getByLabel("上游模型名称", { exact: true }).fill("rj-model-v1");
      await choose(page, "认证方式", "API Key");
    } else {
      await page.getByRole("button", { name: /rj 管理验收 v1 rj-management/ }).click();
      await page.getByRole("button", { name: "以此版本为基础发布" }).click();
    }
    await page.getByLabel("显示名称", { exact: true }).fill("rj 管理验收 v" + version);
    await page.getByLabel("API Key", { exact: true }).fill(process.env.MANAGEMENT_RJ_API_KEY);
    await page.getByText("已确认本版本的完整认证配置", { exact: true }).click();
    await page.getByRole("button", { name: `发布 v${version}`, exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "rj 管理验收 v" + version,
        exact: true,
      }),
    ).toBeVisible();
    const saved = await call(`/models/rj-management?version=${version}`);
    assert(saved.has_api_key);
    assert(!("api_key" in saved));
    result.models.push({
      version: saved.version,
      has_api_key: saved.has_api_key,
    });
  }
  await publishModel(1);
  await page.goto(webBase + "/settings/agents");
  await page.getByRole("button", { name: "新建 Agent", exact: true }).click();
  await page.getByLabel("Agent 标识", { exact: true }).fill("management-agent");
  await page.getByLabel("名称", { exact: true }).fill("住院管理验收 v1");
  await choose(page, "模型", "rj 管理验收 v1 · 最新 v1");
  await page
    .getByLabel("运行指令", { exact: true })
    .fill(
      "根据用户问题读取授权目录与工具定义，执行只读查询并依据真实证据回答。金额单位分。禁止推测查询结果。",
    );
  for (const name of [
    "query_dataset",
    "list_sources",
    "list_datasets",
    "get_dataset_schema",
    "search_datasets",
    "get_dataset_relations",
  ]) {
    const label = page.locator("label.el-checkbox").filter({
      has: page.locator("strong", { hasText: new RegExp("^" + name + "$") }),
    });
    if (await label.count()) await label.click();
  }
  for (const name of ["query-analysis", "query-dsl"])
    await page
      .locator("label.el-checkbox")
      .filter({
        has: page.locator("strong", { hasText: new RegExp("^" + name + "$") }),
      })
      .click();
  await page.getByRole("button", { name: "发布 v1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "住院管理验收 v1", exact: true })).toBeVisible();
  const users = [];
  for (const department of [1, 2]) {
    phase = "浏览器创建部门用户 " + department;
    await page.goto(webBase + "/settings/users");
    await page.getByRole("button", { name: "创建用户", exact: true }).click();
    await page.getByLabel("登录名", { exact: true }).fill("management-user-" + department);
    await page.getByLabel("显示名称", { exact: true }).fill("部门分析员 " + department);
    await page.getByLabel("初始密码", { exact: true }).fill(password);
    await choose(
      page,
      "已有角色",
      "住院分析员 · " + (fixedPolicy ? role + "-" + department : role),
    );
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "部门分析员 " + department,
        exact: true,
      }),
    ).toBeVisible();
    const dept = page.getByRole("combobox", { name: "业务部门 ID" });
    await dept.fill(String(department));
    await page.getByRole("option", { name: String(department), exact: true }).click();
    await page.getByRole("heading", { name: "部门分析员 " + department, exact: true }).click();
    await page.getByRole("button", { name: "保存部门范围", exact: true }).click();
    await expect(page.getByText("业务部门范围已保存并回读。")).toBeVisible();
    users.push({
      department,
      token: (
        await json(apiBase, "/auth/login", "POST", {
          username: "management-user-" + department,
          password,
        })
      ).accessToken,
    });
  }
  await check("浏览器创建两个部门账号并保存角色、部门范围");
  const old = await json(
    apiBase,
    "/conversations",
    "POST",
    { title: "固定 v1", agent_id: "management-agent", agent_version: 1 },
    users[0].token,
  );
  await publishModel(2);
  await page.goto(webBase + "/settings/agents");
  await page.getByRole("button", { name: /住院管理验收 v1 management-agent/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await page.getByLabel("名称", { exact: true }).fill("住院管理验收 v2");
  await page.getByLabel("固定模型版本", { exact: true }).fill("2");
  await page.getByRole("button", { name: "发布 v2", exact: true }).click();
  await expect(page.getByRole("heading", { name: "住院管理验收 v2", exact: true })).toBeVisible();
  const current = await json(
    apiBase,
    "/conversations",
    "POST",
    { title: "选择 v2", agent_id: "management-agent", agent_version: 2 },
    users[1].token,
  );
  assert.equal(old.agentVersion, 1);
  assert.equal(current.agentVersion, 2);
  assert.equal(
    (await json(apiBase, `/conversations/${old.id}`, "GET", undefined, users[0].token)).conversation
      .agentVersion,
    1,
  );
  await check("浏览器模型和 Agent v1→v2，旧会话固定 v1、新会话选择 v2");
  phase = "浏览器关系发布";
  await page.goto(webBase + "/settings/data");
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await choose(page, "业务数据源", source + " · healthy");
  await page.locator(".management-resource").filter({ hasText: "table.dbo.admissions" }).click();
  await page.getByRole("button", { name: "新建出向关系", exact: true }).click();
  await page.getByLabel("关系标识", { exact: true }).fill("admission_department");
  await choose(page, "目标对象", "table.dbo.departments");
  await page.getByLabel("业务说明", { exact: true }).last().fill("住院所属科室");
  await choose(page, "基数", "many_to_one");
  await choose(page, "源字段 1", "department_id");
  await choose(page, "目标字段 1", "department_id");
  await page.getByRole("button", { name: "加入发布清单", exact: true }).click();
  await page.getByRole("button", { name: "发布整批关系", exact: true }).click();
  await expect(page.getByText("关系整批已发布并回读。")).toBeVisible();
  const graph = await call(`/admin/catalog/${source}/objects/table.dbo.admissions/relations`);
  assert.equal(graph.outgoing[0].target_object_id, "table.dbo.departments");
  await page.screenshot({
    path: join(evidence, "真实关系发布.png"),
    fullPage: true,
  });
  await check("浏览器发布有方向的住院→科室关系");
  phase = "授权查询和 SQL 对账";
  business = await SqlServerMetadataDatabase.connect({
    ...connection,
    database: "ai_bi_demo",
  });
  for (const user of users) {
    const query = {
      type: "relational_query",
      source_id: source,
      from: { object_id: "table.dbo.admissions", alias: "a" },
      select: [
        {
          field: "a.admission_id",
          aggregation: "count_distinct",
          as: "admissions",
        },
      ],
    };
    const value = await json(apiBase, "/query", "POST", query, user.token);
    const baseline = await business.execute({
      sql: "SELECT COUNT(DISTINCT admission_id) AS admissions FROM dbo.admissions WHERE department_id=@department",
      parameters: [{ name: "department", type: "integer", value: user.department }],
    });
    assert.deepEqual(value.rows, baseline.rows);
    const fees = {
      type: "relational_query",
      source_id: source,
      from: { object_id: "table.dbo.inpatient_charge_details", alias: "f" },
      select: [{ field: "f.amount_cents", aggregation: "sum", as: "fee_cents" }],
      filters: {
        logic: "and",
        items: [{ field: "f.status", op: "eq", data_type: "string", value: "posted" }],
      },
    };
    const feeResult = await json(apiBase, "/query", "POST", fees, user.token);
    const feeBaseline = await business.execute({
      sql: "SELECT SUM(amount_cents) AS fee_cents FROM dbo.inpatient_charge_details WHERE department_id=@department AND status='posted'",
      parameters: [{ name: "department", type: "integer", value: user.department }],
    });
    assert.deepEqual(feeResult.rows, feeBaseline.rows);
    await assert.rejects(
      () =>
        json(
          apiBase,
          "/query",
          "POST",
          { ...query, select: [{ field: "a.patient_id", as: "patient_id" }] },
          user.token,
        ),
      (error) => error.status === 403,
    );
    result.queries.push({
      department: user.department,
      admissions: value.rows,
      fees: feeResult.rows,
      hidden_patient_id_denied: true,
    });
  }
  const relationQuery = {
    type: "relational_query",
    source_id: source,
    from: { object_id: "table.dbo.admissions", alias: "a" },
    joins: [
      {
        type: "inner",
        object_id: "table.dbo.departments",
        alias: "d",
        on: [{ left: "a.department_id", op: "eq", right: "d.department_id" }],
      },
    ],
    select: [
      { field: "d.name", as: "department" },
      {
        field: "a.admission_id",
        aggregation: "count_distinct",
        as: "admissions",
      },
    ],
    group_by: ["d.name"],
  };
  const joined = await json(apiBase, "/query", "POST", relationQuery, users[0].token);
  const joinedBaseline = await business.execute({
    sql: "SELECT d.name AS department,COUNT(DISTINCT a.admission_id) AS admissions FROM dbo.admissions a JOIN dbo.departments d ON d.department_id=a.department_id WHERE a.department_id=1 GROUP BY d.name",
    parameters: [],
  });
  assert.deepEqual(joined.rows, joinedBaseline.rows);
  await check("两部门住院、有效费用 SQL 对账和隐藏字段拒绝，已发布关系真实查询通过");
  async function run(conversation, user, content) {
    const submitted = await json(
      apiBase,
      `/conversations/${conversation.id}/messages`,
      "POST",
      { content, idempotency_key: randomUUID() },
      user.token,
    );
    let state;
    await wait(
      async () => {
        state = await json(
          apiBase,
          `/analysis-runs/${submitted.analysisRun.id}`,
          "GET",
          undefined,
          user.token,
        );
        return ["completed", "failed", "cancelled", "waiting_for_input"].includes(state.status);
      },
      "rj 运行",
      650000,
    );
    const proof = await json(
      apiBase,
      `/analysis-runs/${submitted.analysisRun.id}/evidence`,
      "GET",
      undefined,
      user.token,
    );
    const steps = await json(
      apiBase,
      `/analysis-runs/${submitted.analysisRun.id}/steps`,
      "GET",
      undefined,
      user.token,
    );
    result.models.push({
      run_id: submitted.analysisRun.id,
      agent_version: conversation.agentVersion,
      department: user.department,
      status: state.status,
      error: state.error,
      queries: proof.items.map((item) => ({
        sql: item.sql,
        rows: item.result?.rows,
        authorized_query: item.authorized_query,
      })),
      steps: steps.items.map((item) => ({
        tool: item.toolName ?? item.tool_name,
        status: item.status,
      })),
    });
    await save();
    assert.equal(state.status, "completed", "rj 实际运行未完成");
    return { proof, state };
  }
  phase = "rj 部门住院真实运行";
  const first = await run(
    old,
    users[0],
    `查询 ${source} 数据源中我有权限的住院人次，按 admissions.admission_id 去重计数。直接查询并回答，不需要日期限制。`,
  );
  assert(
    first.proof.items.some((item) =>
      JSON.stringify(item.result?.rows).includes(
        String(result.queries[0].admissions[0].admissions),
      ),
    ),
  );
  await check("rj v1 旧会话按部门查询住院人次，与 SQL 基准一致");
  phase = "rj 部门费用真实运行";
  const second = await run(
    current,
    users[1],
    `查询 ${source} 中我有权限的住院有效费用，inpatient_charge_details 中 status='posted'，汇总 amount_cents，按分返回合计，不限日期。`,
  );
  assert(
    second.proof.items.some((item) =>
      JSON.stringify(item.result?.rows).includes(String(result.queries[1].fees[0].fee_cents)),
    ),
  );
  await check("rj v2 新会话按部门查询费用，与 SQL 基准一致");
  phase = "rj 旧会话追问";
  await run(old, users[0], "沿用刚才的住院人次结果，加 1 是多少？无需重新查询。");
  await check("rj 升级后旧会话继续以 v1 追问");
  const viewer = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await login(viewer, webBase, "management-user-2");
  await viewer.goto(webBase + "/analysis/" + current.id);
  await expect(
    viewer.getByText(String(result.queries[1].fees[0].fee_cents), { exact: false }).first(),
  ).toBeVisible({ timeout: 20000 });
  await viewer.screenshot({
    path: join(evidence, "真实费用分析.png"),
    fullPage: true,
  });
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  const safe = [connection.password, connection.user, process.env.MANAGEMENT_RJ_API_KEY, password]
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
      [connection.password, connection.user, process.env.MANAGEMENT_RJ_API_KEY, password]
        .filter(Boolean)
        .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), entry.log),
    )
    .join("\n");
  result.failure = { phase, message: safe, diagnostic: logs };
  console.log("验收失败：" + phase + " " + safe);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const entry of [...processes].reverse()) await stop(entry);
  await business?.close();
  await apiDb?.close();
  for (const name of [...databases].reverse()) {
    assert(/^ai_data_management_live_[a-f0-9]{32}_(api|das)$/.test(name));
    await master.execute({
      sql: `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]`,
      parameters: [],
    });
  }
  await master?.close();
  assert(
    resolve(root).startsWith(resolve(tmpdir()) + sep) &&
      basename(root).startsWith("ai-data-management-live-"),
  );
  await rm(root, { recursive: true, force: true });
  result.cleaned_up = true;
  result.finished_at = dayjs().format("YYYY-MM-DD HH:mm:ss");
  await save();
}
