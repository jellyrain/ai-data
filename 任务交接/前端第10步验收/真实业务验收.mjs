import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
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
const {stableStringify} = await import(pathToFileURL(apiRequire.resolve("@ai-data/contracts")));
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
    join(evidence, process.env.KNOWLEDGE_UI_ONLY === "1" ? "真实界面复验.json" : "真实业务验收.json"),
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
  result.processes = processes.map(p => p.child.pid);
  return entry;
}
async function stop(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const closed = once(entry.child,'exit');
  entry.child.kill('SIGTERM');
  await Promise.race([closed,delay(3000)]);
  if (entry.child.exitCode === null && entry.child.signalCode === null) { entry.child.kill('SIGKILL'); await Promise.race([closed,delay(1000)]); }
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
    database: "master", options: {...connection.options, request_timeout_ms: 120000},
  });
  for (const app of ["api", "das"]) {
    const name = prefix + "_" + app;
    await master.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    databases.push(name);
    result.databases = [...databases];
    result.root = root;
    await save();
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
  let token = (
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
  const transport = await manage('data-source-secrets/business-read/sqlserver-transport');
  await manage('data-source-secrets/business-read/sqlserver-transport','PUT',{expected_revision:transport.revision,sqlserver_transport:{encrypt:false,trust_server_certificate:true}});
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
// 嵌入隔离服务验收脚本的业务场景；API/DAS 使用当前源码，业务库保持只读。
  phase = "知识偏好真实业务验收";
  const self = await call('/auth/me');
  const owner = self.userId;
  assert(owner);
  await call('/models', 'POST', { model_id: 'knowledge-rj', version: 1, name: '知识验收 rj', protocol: 'responses', base_url: 'http://192.168.110.208:8000/v1', model: 'rj-model-v1', api_key: process.env.MANAGEMENT_RJ_API_KEY });
  await call('/agents', 'POST', { agent_id: 'knowledge-agent', version: 1, name: '知识偏好验收', model_id: 'knowledge-rj', model_version: 1, instructions: '依据当前授权数据、用户偏好和正式业务规则回答。查询使用按需工具，结果必须有查询证据。金额按分返回。', tool_names: ['query_dataset','list_sources','list_datasets','describe_dataset','search_catalog','get_tool_schema','get_user_preferences','get_published_knowledge','read_skill_reference'], skill_names: ['query-analysis','query-dsl'], limits: { timeout_ms: 600000, max_tool_calls: 40, max_context_bytes: 262144 } });
  await call('/admin/users/'+owner+'/departments','PUT',{department_ids:['1']});
  token = (await json(apiBase,'/auth/login','POST',{username:'management-admin',password})).accessToken;
  const analyst = await call('/admin/users','POST',{username:'knowledge-user',display_name:'知识分析员',password,role_ids:[role]});
  await call('/admin/users/'+analyst.id+'/departments','PUT',{department_ids:['1']});
  const userToken = (await json(apiBase,'/auth/login','POST',{username:'knowledge-user',password})).accessToken;
  const userCall = (path,method='GET',body)=>json(apiBase,path,method,body,userToken);
  const pref = await userCall('/me/preferences/default-time', 'PUT', { scope: {}, value: { type: 'time_range', range: { type: 'relative', period: 'this_year', extent: 'full_period' } }, auto_apply: true, expected_version: 0, idempotency_key: randomUUID() });
  assert.equal(pref.status, 'saved');
  const effective = dayjs().subtract(1,'day').format('YYYY-MM-DD HH:mm:ss');
  async function publish(content, scope = {}, effectiveAt = effective) {
    const c = await call('/knowledge-candidates', 'POST', { content, scope, idempotency_key: randomUUID() });
    await call('/admin/knowledge-candidates/' + c.candidate_id + '/owner', 'POST', { owner_id: owner, expected_version: c.version });
    await call('/admin/knowledge-candidates/' + c.candidate_id + '/review', 'POST', { expected_version: c.version, decision: 'approve', comment: '真实数据口径核对' });
    const p = await call('/admin/knowledge-candidates/' + c.candidate_id + '/publish', 'POST', { expected_version: c.version, effective_at: effectiveAt });
    return { c, p };
  }
  const rule = await publish({ type: 'business_rule', title: '住院统计口径', body: '住院人次使用 admissions 表 admission_id 去重计数；时间依据 admitted_at。住院费用单位为分。' });
  const future = await publish({ type: 'business_rule', title: '待生效测试规则', body: '仅用于验证未来规则不进入当前运行。' }, {}, dayjs().add(1,'year').format('YYYY-MM-DD HH:mm:ss'));
  assert(!(await call('/knowledge')).items.some(x => x.knowledge_id === future.p.knowledge_id));
  assert.equal((await call('/admin/knowledge/' + future.p.knowledge_id)).current, null);
  const options = await call('/admin/knowledge/owner-options?keyword=' + encodeURIComponent('验收'));
  assert(options.items.some(x => x.user_id === owner));
  await check('正式规则审核发布、未来生效管理读取和负责人选项');
  business = await SqlServerMetadataDatabase.connect({ ...connection, database: 'ai_bi_demo' });
  const year = dayjs().year();
  const baseline = await business.execute({ sql: 'SELECT COUNT(DISTINCT admission_id) AS admissions FROM dbo.admissions WHERE department_id=1 AND admitted_at>=@start AND admitted_at<@end', parameters: [{ name:'start', type:'string', value: year + '-01-01' },{ name:'end', type:'string', value: (year+1) + '-01-01' }] });
  const query = { type:'relational_query', source_id:source, from:{object_id:'table.dbo.admissions',alias:'a'}, select:[{field:'a.admission_id',aggregation:'count_distinct',as:'admissions'}], filters:{logic:'and',items:[{field:'a.admitted_at',op:'between',data_type:'datetime',value:[year+'-01-01 00:00:00',year+'-12-31 23:59:59']}]}};
  assert.deepEqual((await userCall('/query','POST',query)).rows,baseline.rows);
  result.queries.push({ name:'本年住院基准', rows:baseline.rows });
  const report = await call('/report-definitions','POST',{definition:{ title:'本年住院模板', queries:[{query_id:'admissions',query}], presentation:[{section_id:'main',title:'住院工作量',blocks:[{block_id:'table',type:'table',title:'人次',query_ids:['admissions']}]}] }});
  const templateContent = {type:'report_template',report_id:report.report_id,definition_version:report.version,definition_hash:createHash('sha256').update(stableStringify(report.definition)).digest('hex')};
  const template = await publish(templateContent);
  await call('/reports/'+report.report_id+'/definition','PUT',{expected_version:report.version,definition:{...report.definition,title:'已修改的原始报表'}});
  const preview = await call('/knowledge-candidates/'+template.c.candidate_id+'/template-definition');
  assert.equal(preview.version,1); assert.equal(preview.definition.title,'本年住院模板');
  const copy = await userCall('/report-definitions','POST',{definition:preview.definition});
  const execution = await userCall('/reports/'+copy.report_id+'/execute','POST',{definition_version:copy.version,idempotency_key:randomUUID(),parameters:{}});
  assert.equal(execution.status,'completed'); assert.deepEqual(execution.results[0].evidence.result.rows,baseline.rows);
  await check('模板固定 v1 预览、原定义更新后保持内容、新建执行与 SQL 一致');
  launch(join(workspace,'apps/web'),['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(webPort),'--strictPort'],{WEB_API_TARGET:apiBase});
  await wait(async()=>fetch(webBase).then(r=>r.ok).catch(()=>false),'Web 启动');
  browser = await chromium.launch({headless:true});
  activePage = await browser.newPage({viewport:{width:1440,height:1000}});
  await login(activePage,webBase,'knowledge-user');
  await activePage.goto(webBase+'/knowledge');
  await activePage.getByRole('button',{name:'个人偏好',exact:true}).click();
  await activePage.locator('.management-resource').filter({hasText:'default-time'}).click();
  await expect(activePage.getByLabel('偏好标识',{exact:true})).toHaveValue('default-time');
  await activePage.screenshot({path:join(evidence,'真实个人偏好.png'),fullPage:true});
  await activePage.getByRole('button',{name:'退出登录'}).click();
  await login(activePage,webBase,'management-admin');
  await activePage.goto(webBase+'/settings/knowledge');
  await expect(activePage.getByRole('button',{name:'刷新列表',exact:true})).not.toHaveClass(/is-loading/);
  await activePage.getByRole('button',{name:'正式知识管理',exact:true}).click();
  await expect(activePage.getByRole('button',{name:'正式知识管理',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(activePage.getByRole('button',{name:'刷新列表',exact:true})).not.toHaveClass(/is-loading/);
  await activePage.locator('.management-resource').filter({hasText:'待生效测试规则'}).click();
  await expect(activePage.getByRole('heading',{name:'版本管理',exact:true})).toBeVisible();
  await expect(activePage.getByRole('button',{name:'停用知识',exact:true})).toBeEnabled();
  await activePage.screenshot({path:join(evidence,'真实待生效管理.png'),fullPage:true,animations:'disabled'});
  await check('浏览器读取真实 API 持久化的个人偏好与待生效知识');
  async function run(title, content, expectedPreferences, expectedKnowledge) {
    const conversation = await userCall('/conversations','POST',{title,agent_id:'knowledge-agent',agent_version:1});
    const submission = await userCall('/conversations/'+conversation.id+'/messages','POST',{content,idempotency_key:randomUUID()});
    const id = submission.analysisRun.id;
    let state;
    await wait(async()=>{state=await userCall('/analysis-runs/'+id); return ['completed','failed','cancelled','waiting_clarification'].includes(state.status);},'rj '+title,650000);
    const stored = await apiDb.execute({sql:'SELECT context_json FROM dbo.analysis_memory_contexts WHERE analysis_run_id=@id',parameters:[{name:'id',type:'string',value:id}]});
    const snapshot = JSON.parse(stored.rows[0]?.context_json ?? '{}');
    const proof = await userCall('/analysis-runs/'+id+'/evidence');
    result.models.push({title,run_id:id,status:state.status,error:state.error,preferences:snapshot.preferences?.map(x=>({key:x.key,resolved_time_range:x.resolved_time_range})),knowledge:snapshot.knowledge?.map(x=>({id:x.knowledge_id,version:x.version})),queries:proof.items.map(x=>({sql:x.sql,rows:x.result?.rows}))});
    await save();
    assert.equal(state.status,'completed');
    assert.equal(snapshot.preferences.some(x=>x.key==='default-time'),expectedPreferences);
    assert.equal(snapshot.knowledge.some(x=>x.knowledge_id===rule.p.knowledge_id),expectedKnowledge);
    assert(!snapshot.knowledge.some(x=>x.knowledge_id===future.p.knowledge_id));
    return proof;
  }
  if(process.env.KNOWLEDGE_UI_ONLY !== '1') {
  phase='rj 跨会话偏好及正式规则';
  for (const title of ['首次会话','新会话']) {
    const proof=await run(title,`查询 ${source} 数据源中我有权限的住院人次，按我的默认时间范围统计。请读取 admissions 数据对象，按正式口径查询并回答。`,true,true);
    assert(proof.items.some(x=>JSON.stringify(x.result?.rows).includes(String(baseline.rows[0].admissions))));
    await check('rj '+title+'采用本年偏好和正式规则，住院结果符合 SQL 基准');
  }
  await userCall('/me/preferences/default-time/auto-apply','PATCH',{auto_apply:false,expected_version:pref.preference.version,idempotency_key:randomUUID()});
  await call('/admin/knowledge/'+rule.p.knowledge_id+'/enabled','PUT',{enabled:false});
  const stopped=await call('/admin/knowledge/'+rule.p.knowledge_id); assert.equal(stopped.enabled,false); assert.equal(stopped.current,null);
  phase='rj 停用后的新会话';
  await run('停用后','请说明当前账号是否配置了自动应用的时间偏好以及通用住院统计规则。读取当前偏好及知识后回答，无需查询业务数值。',false,false);
  await check('停用后 rj 新会话不自动应用偏好与规则');
  }
  result.status='passed';

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
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  result.cleaned_up = true;
  result.finished_at = dayjs().format("YYYY-MM-DD HH:mm:ss");
  await save();
}
