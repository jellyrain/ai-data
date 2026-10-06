import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// 仅创建本次随机命名的 API/DAS 元数据库，正式配置仅用于取得测试数据库连接。
const workspace = fileURLToPath(new URL("../../ai-data/", import.meta.url));
const output = fileURLToPath(new URL("./结果.json", import.meta.url));
const requireDas = createRequire(
  join(workspace, "apps/data-access/package.json"),
);
const sql = requireDas("mssql");
const dayjs = requireDas("dayjs");
dayjs.extend(requireDas("dayjs/plugin/utc"));
const current = JSON.parse(
  await readFile(join(workspace, "apps/api/config/api.config.json"), "utf8"),
);
const connection = current.metadata_sqlserver;
const prefix = `ai_das_auto_test_${randomUUID().replaceAll("-", "")}`;
const databases = [];
const roots = [];
const children = [];
const checks = [];
const secrets = [connection.password, connection.user, connection.server];
let admin;
let failed = false;

function check(name) {
  checks.push(name);
  process.stdout.write(`通过：${name}\n`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitFor(predicate, description, timeout = 45000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(`等待超时：${description}`);
}

function launch(root) {
  const env = { ...process.env };
  delete env.API_CONFIG_PATH;
  const child = spawn(process.execPath, ["dist/index.mjs"], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = { child, logs: "", exited: false, exit: once(child, "exit") };
  child.once("exit", () => {
    entry.exited = true;
  });
  child.stdout.on("data", (chunk) => {
    entry.logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    entry.logs += chunk;
  });
  children.push(entry);
  return entry;
}

async function stop(entry) {
  if (!entry.exited) {
    entry.child.kill();
    await entry.exit;
  }
}

async function request(base, path, method = "GET", body, token) {
  return fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
}

async function healthy(base, entry) {
  assert(!entry.exited, "验收服务提前退出");
  try {
    return (await request(base, "/health")).ok;
  } catch {
    return false;
  }
}

try {
  admin = await new sql.ConnectionPool({
    server: connection.server,
    port: connection.port,
    database: "master",
    user: connection.user,
    password: connection.password,
    options: {
      encrypt: connection.options.encrypt,
      trustServerCertificate: connection.options.trust_server_certificate,
    },
    connectionTimeout: 10000,
    requestTimeout: 30000,
    pool: { min: 0, max: 2, idleTimeoutMillis: 1000 },
  }).connect();
  for (const app of ["api", "data-access"]) {
    const name = `${prefix}_${app === "api" ? "api" : "das"}`;
    assert.match(name, /^ai_das_auto_test_[a-f0-9]{32}_(api|das)$/);
    await admin.request().query(`CREATE DATABASE [${name}]`);
    databases.push(name);
    const parent = resolve(workspace, "apps", app, "dist");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "registration-acceptance-"));
    roots.push({ parent, root });
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "config"));
    await mkdir(join(root, "secrets"));
    await cp(join(parent, "index.js"), join(root, "dist/index.mjs"));
    await cp(
      join(workspace, "apps", app, "migrations"),
      join(root, "migrations"),
      { recursive: true },
    );
  }
  const apiRoot = roots[0].root;
  const dasRoot = roots[1].root;
  const apiPort = await freePort();
  const dasPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const dasBase = `http://127.0.0.1:${dasPort}`;
  const secret = randomBytes(32).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  secrets.push(secret, password);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privatePem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  secrets.push(privatePem);
  const api = JSON.parse(
    await readFile(
      join(workspace, "apps/api/config/api.config.example.json"),
      "utf8",
    ),
  );
  api.service = { ...api.service, host: "127.0.0.1", port: apiPort };
  api.metadata_sqlserver = { ...connection, database: databases[0] };
  api.analysis_runtime = {
    enabled: false,
    state_directory: "secrets/runtime",
    skills_directory: join(workspace, "packages/skills"),
  };
  api.memory_tasks = { enabled: false };
  api.trusted_data_access_services = [
    {
      service_id: "auto-das",
      credential_version: 1,
      enabled: true,
      registration_secret: secret,
    },
  ];
  api.jwt.signing_private_key_pem = privatePem;
  api.jwt.verification_public_key_pem = publicPem;
  api.bootstrap_admin = {
    organization_id: "auto-org",
    organization_code: "auto",
    organization_name: "接入验收",
    username: "auto-admin",
    display_name: "验收管理员",
    password,
  };
  const das = JSON.parse(
    await readFile(
      join(
        workspace,
        "apps/data-access/config/das.release.config.example.json",
      ),
      "utf8",
    ),
  );
  das.service = {
    ...das.service,
    host: "127.0.0.1",
    port: dasPort,
    service_id: "auto-das",
  };
  das.metadata_sqlserver = { ...connection, database: databases[1] };
  das.api.base_url = apiBase;
  das.api.registration_secret = secret;
  await writeFile(
    join(apiRoot, "config/api.config.json"),
    JSON.stringify(api),
    { mode: 0o600 },
  );
  await writeFile(
    join(dasRoot, "config/das.config.json"),
    JSON.stringify(das),
    { mode: 0o600 },
  );
  const publicPath = join(dasRoot, "secrets/api-public.pem");
  await writeFile(publicPath, publicPem);
  const fingerprint = createHash("sha256").update(publicPem).digest("hex");

  let dasProcess = launch(dasRoot);
  await waitFor(() => healthy(dasBase, dasProcess), "DAS 先启动");
  await waitFor(
    () => dasProcess.logs.includes("无法连接 API"),
    "API 未启动时记录连接提示",
    10000,
  );
  check("DAS 在 API 尚未启动时仍可监听，等待自动重试");

  let apiProcess = launch(apiRoot);
  await waitFor(() => healthy(apiBase, apiProcess), "API 启动");
  const login = await request(apiBase, "/auth/login", "POST", {
    username: "auto-admin",
    password,
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).accessToken;
  secrets.push(token);
  const registered = async () => {
    const response = await request(
      apiBase,
      "/admin/data-access/services",
      "GET",
      undefined,
      token,
    );
    assert.equal(response.status, 200);
    return (await response.json()).items.some(
      (item) =>
        item.service_id === "auto-das" && item.connection_status === "online",
    );
  };
  await waitFor(registered, "DAS 自动领取并注册");
  assert(!("registration_credential_path" in das.api));
  assert(
    !(await readdir(join(dasRoot, "secrets"))).some((name) =>
      name.endsWith(".jwt"),
    ),
  );
  check("配置密钥后真实 DAS 自动领取 JWT 并注册，实例目录未生成 JWT 文件");

  const readSources = await request(
    apiBase,
    "/admin/data-access/services/auto-das/data-sources",
    "GET",
    undefined,
    token,
  );
  assert.equal(readSources.status, 200);
  check("API 签名管理请求通过 DAS 公钥文件验签");

  await stop(apiProcess);
  apiProcess = launch(apiRoot);
  await waitFor(() => healthy(apiBase, apiProcess), "API 重启");
  await waitFor(registered, "API 重启后的自动重新注册");
  assert(!dasProcess.exited);
  check("API 进程重启后，原 DAS 进程重新领取并恢复注册");

  const exchange = (registrationSecret, service_id = "auto-das") =>
    request(
      apiBase,
      "/internal/data-access/credential",
      "POST",
      { service_id },
      registrationSecret,
    );
  assert.equal(
    (await exchange(randomBytes(32).toString("base64url"))).status,
    401,
  );
  assert.equal((await exchange(secret, "another-das")).status, 401);
  check("错误密钥和跨实例领取请求返回 401");
  const issued = await exchange(secret);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const oldCredential = (await issued.json()).credential;
  secrets.push(oldCredential);
  const heartbeat = {
    service_id: "auto-das",
    service_port: dasPort,
    service_protocol: "http",
    status: "healthy",
    sent_at: "2026-10-06 12:00:00",
    sources: [],
  };
  const oldRegister = await request(
    apiBase,
    "/internal/data-access/register",
    "POST",
    heartbeat,
    oldCredential,
  );
  assert.equal(oldRegister.status, 200);
  const oldSession = (await oldRegister.json()).session_token;
  secrets.push(oldSession);

  await stop(apiProcess);
  api.trusted_data_access_services[0].enabled = false;
  await writeFile(
    join(apiRoot, "config/api.config.json"),
    JSON.stringify(api),
    { mode: 0o600 },
  );
  apiProcess = launch(apiRoot);
  await waitFor(() => healthy(apiBase, apiProcess), "停用配置启动");
  assert.equal((await exchange(secret)).status, 401);
  assert.equal(await registered(), false);
  check("实例停用后不能领取或参与健康调度");

  await stop(apiProcess);
  const nextSecret = randomBytes(32).toString("base64url");
  secrets.push(nextSecret);
  api.trusted_data_access_services[0] = {
    service_id: "auto-das",
    credential_version: 2,
    enabled: true,
    registration_secret: nextSecret,
  };
  await writeFile(
    join(apiRoot, "config/api.config.json"),
    JSON.stringify(api),
    { mode: 0o600 },
  );
  apiProcess = launch(apiRoot);
  await waitFor(() => healthy(apiBase, apiProcess), "轮换配置启动");
  assert.equal((await exchange(secret)).status, 401);
  assert.equal(
    (
      await request(
        apiBase,
        "/internal/data-access/register",
        "POST",
        heartbeat,
        oldCredential,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        apiBase,
        "/internal/data-access/heartbeat",
        "POST",
        heartbeat,
        oldSession,
      )
    ).status,
    401,
  );
  await stop(dasProcess);
  das.api.registration_secret = nextSecret;
  await writeFile(
    join(dasRoot, "config/das.config.json"),
    JSON.stringify(das),
    { mode: 0o600 },
  );
  dasProcess = launch(dasRoot);
  await waitFor(() => healthy(dasBase, dasProcess), "DAS 载入新密钥");
  await waitFor(registered, "新密钥接入");
  check("密钥与版本轮换后旧身份失效，新密钥完成接入");

  await stop(dasProcess);
  das.api.jwt_verification_public_key_path = "../secrets/missing-public.pem";
  await writeFile(
    join(dasRoot, "config/das.config.json"),
    JSON.stringify(das),
    { mode: 0o600 },
  );
  dasProcess = launch(dasRoot);
  await waitFor(() => dasProcess.exited, "公钥缺失时启动拒绝", 10000);
  assert.equal(dasProcess.child.exitCode, 1);
  assert.equal(
    createHash("sha256")
      .update(await readFile(publicPath))
      .digest("hex"),
    fingerprint,
  );
  check("API 公钥文件仍为启动必要项，整个验收期间原公钥内容保持一致");

  for (const entry of children) {
    for (const value of secrets.filter((value) => value && value.length >= 8))
      assert(!entry.logs.includes(value), "服务日志包含敏感输入");
  }
  check("服务日志未包含本次接入密钥、JWT、会话或数据库认证信息");
} catch (error) {
  failed = true;
  const message = secrets
    .filter(Boolean)
    .reduce(
      (text, value) => text.replaceAll(value, "[redacted]"),
      String(error.message),
    );
  process.stderr.write(`验收失败：${message}\n`);
} finally {
  for (const entry of children.toReversed()) await stop(entry);
  for (const name of databases.toReversed()) {
    assert.match(name, /^ai_das_auto_test_[a-f0-9]{32}_(api|das)$/);
    await admin
      .request()
      .query(
        `ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]`,
      );
  }
  await admin?.close();
  for (const { parent, root } of roots) {
    assert.equal(dirname(resolve(root)), parent);
    assert(basename(root).startsWith("registration-acceptance-"));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  const report = {
    passed: !failed,
    checks,
    cleanup: {
      stopped_processes: children.length,
      dropped_isolated_databases: databases.length,
      removed_temporary_directories: roots.length,
    },
    finished_at: dayjs().utcOffset(8).format("YYYY-MM-DD HH:mm:ss"),
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (failed) process.exitCode = 1;
}
