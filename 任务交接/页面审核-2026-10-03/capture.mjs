import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 复用已安装浏览器与隔离验收服务，截取当前产品代码的真实视口。
const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, '../..');
const web = path.join(root, 'ai-data/apps/web');
const apiRequire = createRequire(path.join(root, 'ai-data/apps/api/package.json'));
const webRequire = createRequire(path.join(web, 'package.json'));
const { register } = apiRequire('tsx/esm/api');
register();
const { chromium, expect } = webRequire('@playwright/test');
const { default: setup } = await import(pathToFileURL(path.join(web, 'tests/support/e2e-servers.ts')));
const { managementFixture } = await import(pathToFileURL(path.join(web, 'tests/support/management-fixture.ts')));
const { knowledgeFixture } = await import(pathToFileURL(path.join(web, 'tests/support/knowledge-fixture.ts')));
const contract = apiRequire('@ai-data/contracts');
const filter = process.argv.slice(2);
const shots = new Map();
try { for (const item of JSON.parse(await readFile(path.join(output, 'screenshots.json'), 'utf8')).screenshots) shots.set(item.id, item); } catch {}
const failures = [];
const pageErrors = [];
await mkdir(path.join(output, 'images'), { recursive: true });
process.env.WEB_E2E_PREVIEW = '1';
const stop = await setup();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, baseURL: 'http://127.0.0.1:5317', colorScheme: 'light', locale: 'zh-CN' });

async function settle(page) {
  await page.locator('.el-skeleton').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}
async function saveManifest() {
  await writeFile(path.join(output, 'screenshots.json'), JSON.stringify({ viewport: { width: 1920, height: 1080 }, environment: '当前 Web 生产构建 + 隔离验收数据', screenshots: [...shots.values()].sort((a,b) => a.id.localeCompare(b.id)), failures, pageErrors }, null, 2));
}
async function snap(page, id, module, title, note = '', top = true) {
  await settle(page);
  if (top) await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(1910, 1070);
  await page.waitForTimeout(200);
  const filename = shots.get(id)?.file ?? `images/${id}-${title}.png`;
  await page.screenshot({ path: path.join(output, filename), fullPage: false, animations: 'disabled' });
  const data = await readFile(path.join(output, filename));
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width !== 1920 || height !== 1080) throw new Error('截图尺寸不符');
  const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollY }));
  shots.set(id, { id, module, title, file: filename, route: new URL(page.url()).pathname, width, height, theme: await page.locator('html').getAttribute('data-mode'), note, layout });
  console.log(`已截图 ${id} ${title}`);
  await saveManifest();
}
async function choose(page, label, value) {
  const input = page.getByRole('combobox', { name: label, exact: true });
  await input.locator("xpath=ancestor::*[contains(@class,'el-select__wrapper')]").click();
  const controls = await input.getAttribute('aria-controls');
  await page.locator(`[id="${controls}"]`).getByRole('option', { name: value, exact: true }).click();
}
async function theme(page, mode) {
  await page.getByRole('button', { name: '外观设置', exact: true }).click();
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('button', { name: '橄榄绿', exact: true }).click();
  await page.getByRole('button', { name: '外观设置', exact: true }).click();
  await expect(page.locator('.appearance-panel')).toBeHidden();
}
async function goto(page, url) { await page.goto(url); await settle(page); }
async function group(name, task, fixture) {
  if (filter.length && !filter.includes(name)) return;
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push({ group: name, message: error.message }));
  try {
    const data = fixture ? await fixture(page) : undefined;
    await task(page, data);
  } catch (error) {
    failures.push({ group: name, message: String(error) });
    console.log(`截图组失败 ${name}: ${String(error).slice(0,700)}`);
    await writeFile(path.join(output, `debug-${name}.txt`), await page.locator('body').innerText()).catch(() => {});
  } finally { await page.close(); await saveManifest(); }
}

function seedKnowledge(data) {
  const now = '2026-10-03 10:00:00';
  const org = 'test-organization', user = 'test-admin';
  const rule = { type: 'business_rule', title: '住院费用统计口径', body: '按出院日期确定统计期间，按住院记录去重计算出院人次。费用按有效记账记录汇总，退费按实际金额冲减。\n\n按科室汇总时，使用患者出院时所属科室。比较不同月份时采用相同的统计口径。' };
  for (const [id, title, status] of [['inpatient-rule', rule.title, 'published'], ['outpatient-rule', '门诊人次去重规则', 'pending'], ['fee-rule', '费用分类口径补充', 'approved']]) {
    const body = id === 'outpatient-rule' ? '按就诊日期确定统计期间，以有效门诊记录的就诊标识去重计算门诊人次。取消挂号记录不计入业务量。\n\n按就诊科室汇总，跨科室复诊分别计次。月度对比采用相同口径，并注明实际日期范围。' : id === 'fee-rule' ? '费用按收费项目分类汇总，使用实际记账金额；退费按原项目分类冲减。金额单位统一为元，展示保留两位小数。' : rule.body;
    data.candidates.push(contract.knowledgeCandidateSchema.parse({ candidate_id: 'candidate-'+id, knowledge_id: id, content: { ...rule, title, body }, scope: {}, content_hash: 'a'.repeat(64), organization_id: org, version: 1, status, created_by: user, owner_id: user, created_at: now, updated_at: now }));
  }
  for (const [id, content, effective] of [
    ['inpatient-rule', rule, '2026-10-01 00:00:00'],
    ['future-rule', { ...rule, title: '下一统计周期费用口径' }, '2026-11-01 00:00:00']
  ]) data.publications.push(contract.publishedKnowledgeSchema.parse({ knowledge_id: id, version: 1, content, scope: {}, owner_id: user, organization_id: org, published_by: user, source_candidate_id: 'candidate-'+id, effective_at: effective, published_at: now }));
  for (const [key, value] of [
    ['default-period', { type: 'time_range', range: { type: 'relative', period: 'this_year', extent: 'to_date' } }],
    ['result-display', { type: 'presentation', format: 'chart', chart_type: 'bar' }]
  ]) data.preferences.set(key, contract.userPreferenceSchema.parse({ key, scope: {}, value, auto_apply: true, organization_id: org, user_id: user, version: 1, updated_at: now, source: { evidence_ids: [] }, use_count: 8, last_used_at: now }));
  for (const [i, status] of ['processing', 'pending', 'done', 'done'].entries()) data.tasks.push(contract.memoryEventSummarySchema.parse({ event_id: 'memory-'+(i+1), analysis_run_id: 'analysis-'+(i+1), status, attempts: status === 'pending' ? 0 : 1, created_at: now, updated_at: now, last_error_code: null }));
}

try {
  const login = await context.newPage();
  await goto(login, '/login');
  if (!filter.length || filter.includes('login')) await snap(login, '01', '登录', '登录页');
  await login.getByLabel('用户名', { exact: true }).fill('admin');
  await login.getByLabel('密码', { exact: true }).fill('Web-test-2026!');
  await login.getByRole('button', { name: '登录工作台', exact: true }).click();
  await expect(login.getByRole('heading', { name: '分析工作台', exact: true })).toBeVisible();
  await login.close();

  await group('analysis', async page => {
    await goto(page, '/analysis');
    await snap(page, '02', '分析工作台', '分析工作台-新会话');
    await page.getByRole('textbox', { name: '分析问题', exact: true }).fill('流式分析本年各科室门诊人次的变化趋势');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.locator('.assistant-message').first()).toContainText('我先核对本年的');
    await snap(page, '03', '分析工作台', '分析工作台-文字生成中', '本轮新增流式文字；动态过程见流式验收录屏。');
    await expect(page.locator('.tool-record').first()).toContainText('执行中');
    await snap(page, '04', '分析工作台', '分析工作台-工具执行中', '工具位于前后说明之间，完成后在原处更新状态。');
    await expect(page.locator('.assistant-message').nth(1)).toContainText('本年各科室的门诊记录。');
    await snap(page, '05', '分析工作台', '分析工作台-工具后的说明', '前一工具已完成，后续说明随生成显示；最终结果另见专项验收截图。');
  });

  await group('reports', async page => {
    await goto(page, '/reports');
    await expect(page.locator('.report-row').first()).toBeVisible();
    await snap(page, '06', '报表中心', '报表中心');
    await goto(page, '/reports/report-01');
    await expect(page.getByRole('heading', { name: '门诊人次', exact: true })).toBeVisible();
    await snap(page, '07', '报表中心', '报表详情-条件与结果');
    await page.getByRole('heading', { name: '科室分布', exact: true }).scrollIntoViewIfNeeded();
    await snap(page, '08', '报表中心', '报表详情-图表与费用', '报表下半部分。', false);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await expect(page.getByRole('button', { name: '生成文件', exact: true })).toBeVisible();
    await snap(page, '09', '报表中心', '报表导出面板');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '分享', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存分享设置', exact: true })).toBeVisible();
    await snap(page, '10', '报表中心', '报表分享面板');
  });

  await group('editor', async page => {
    await goto(page, '/reports/report-01/edit');
    await expect(page.getByLabel('报表标题', { exact: true })).toHaveValue('门诊与费用月报');
    await snap(page, '11', '报表中心', '报表编辑-查询表单');
    await page.getByRole('button', { name: '展示配置', exact: true }).click();
    await snap(page, '12', '报表中心', '报表编辑-展示配置');
    const record = { report_id: 'review-graph', version: 1, user_id: 'test-admin', organization_id: 'test-organization', created_at: '2026-10-03 10:00:00', shared_with: [], definition: { title: '科室查询关系', parameters: [], queries: [{ query_id: 'visits', query: { type: 'relational_query', source_id: 'clinical', from: { object_id: 'visits', alias: 'v' }, select: [{ field: 'v.department' }], joins: [{ type: 'left', object_id: 'department', alias: 'd', source_alias: 'v', relation_id: 'department' }], filters: { logic: 'and', items: [] }, group_by: [], order_by: [] }, bindings: [] }], presentation: [{ section_id: 'main', title: '业务概览', blocks: [{ block_id: 'table', type: 'table', title: '科室明细', query_ids: ['visits'] }] }], block_references: [] } };
    await page.route('**/reports/review-graph/definition', route => route.fulfill({ json: contract.reportDefinitionVersionSchema.parse(record) }));
    await goto(page, '/reports/review-graph/edit');
    await page.getByRole('button', { name: '画布', exact: true }).click();
    await expect(page.locator('.query-node')).toHaveCount(2);
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await snap(page, '13', '报表中心', '报表画布-亮色');
    await theme(page, '暗色');
    await snap(page, '14', '报表中心', '报表画布-暗色', '关系线动态流光在静态截图中只保留当前帧。');
    await page.getByRole('button', { name: '打开查询属性', exact: true }).click();
    await snap(page, '15', '报表中心', '报表画布-查询属性');
    await theme(page, '亮色');
  });

  await group('models', async page => {
    await goto(page, '/settings/models');
    await page.getByRole('button', { name: /院内模型 rj/ }).click();
    await snap(page, '16', '模型管理', '模型管理-版本详情');
    await page.getByRole('button', { name: '以此版本为基础发布', exact: true }).click();
    await snap(page, '17', '模型管理', '模型管理-配置表单');
  }, managementFixture);
  await group('agents', async page => {
    await goto(page, '/settings/agents');
    await page.getByRole('button', { name: /住院分析助手 clinical/ }).click();
    await snap(page, '18', 'Agent 管理', 'Agent管理-版本详情');
    await page.getByRole('button', { name: '以此版本为基础发布', exact: true }).click();
    await snap(page, '19', 'Agent 管理', 'Agent管理-配置表单');
    await page.getByRole('heading', { name: '单轮运行限制', exact: true }).scrollIntoViewIfNeeded();
    await snap(page, '19a', 'Agent 管理', 'Agent管理-Skill与运行限制', '配置表单下半部分。', false);
  }, managementFixture);
  await group('users', async page => {
    await goto(page, '/settings/users');
    await page.getByRole('button', { name: /住院业务员 u1/ }).click();
    await snap(page, '20', '用户管理', '用户管理-账号授权');
    await page.getByRole('button', { name: '创建用户', exact: true }).click();
    await snap(page, '21', '用户管理', '用户管理-创建账号');
  }, managementFixture);
  await group('permissions', async page => {
    await goto(page, '/settings/permissions');
    await choose(page, '策略数据源', 'clinical');
    await choose(page, '策略角色', '业务分析员 · analyst');
    await page.getByRole('button', { name: /住院记录 visits/ }).click();
    await snap(page, '22', '角色与权限', '角色与权限-授权规则');
    await page.getByRole('button', { name: '字段操作', exact: true }).click();
    await snap(page, '22a', '角色与权限', '角色与权限-字段操作');
    await page.getByRole('button', { name: '行范围', exact: true }).click();
    await snap(page, '22b', '角色与权限', '角色与权限-行范围');
  }, managementFixture);
  await group('data', async page => {
    await goto(page, '/settings/data');
    await choose(page, 'DAS 实例', 'das-demo · 在线');
    await page.getByRole('button', { name: /clinical clinical 启用/ }).click();
    await expect(page.getByRole('heading', { name: '数据源配置', exact: true })).toBeVisible();
    await snap(page, '23', '数据管理', '数据管理-DAS与数据源');
    await page.getByRole('button', { name: /visits visits 可查询/ }).click();
    await snap(page, '24', '数据管理', '数据管理-对象白名单', '向下查看对象编辑与白名单。', false);
    await page.getByRole('button', { name: '应用对象编辑', exact: true }).scrollIntoViewIfNeeded();
    await snap(page, '24a', '数据管理', '数据管理-对象能力编辑', '白名单下半部分的对象配置。', false);
    await page.getByRole('button', { name: '保存数据库凭据', exact: true }).click();
    await choose(page, '连接参数凭据', 'demo-ref');
    await page.getByRole('region', { name: '已有凭据连接参数' }).scrollIntoViewIfNeeded();
    await snap(page, '25', '数据管理', '数据管理-数据库连接参数', 'Web 管理业务数据库加密与证书信任。', false);
  }, managementFixture);
  await group('catalog', async page => {
    await goto(page, '/settings/data');
    await page.getByRole('button', { name: '业务目录与关系', exact: true }).click();
    await choose(page, '业务数据源', 'clinical · healthy');
    await page.getByRole('button', { name: /住院记录 visits/ }).click();
    await snap(page, '26', '数据管理', '数据管理-业务目录');
    await page.getByRole('button', { name: '新建出向关系', exact: true }).click();
    await page.getByLabel('关系标识', { exact: true }).fill('visit_department');
    for (const [label, option] of [['目标对象','departments'],['源字段 1','department_id'],['目标字段 1','id']]) await choose(page, label, option);
    await page.getByLabel('业务说明', { exact: true }).last().fill('住院记录所属科室');
    await page.getByRole('button', { name: '加入发布清单', exact: true }).click();
    await page.getByRole('button', { name: '发布整批关系', exact: true }).click();
    const graph = page.getByLabel('已发布关系方向图');
    await expect(graph.locator('.vue-flow__node')).toHaveCount(2);
    await graph.scrollIntoViewIfNeeded();
    await snap(page, '27', '数据管理', '数据管理-已发布关系图', '隔离数据中发布一条关系，展示真实关系管理布局。', false);
  }, managementFixture);
  await group('knowledge', async (page, data) => {
    seedKnowledge(data);
    await goto(page, '/knowledge');
    await page.locator('.management-resource').filter({ hasText: '住院费用统计口径' }).click();
    await snap(page, '28', '知识与偏好', '知识与偏好-企业知识');
    await page.getByRole('button', { name: '个人偏好', exact: true }).click();
    await page.locator('.management-resource').filter({ hasText: 'default-period' }).click();
    await snap(page, '29', '知识与偏好', '知识与偏好-个人偏好');
    await page.getByRole('button', { name: '我的候选', exact: true }).click();
    await page.locator('.management-resource').filter({ hasText: '门诊人次去重规则' }).click();
    await snap(page, '30', '知识与偏好', '知识与偏好-我的候选');
    await page.getByRole('button', { name: '待我审核', exact: true }).click();
    await page.locator('.management-resource').filter({ hasText: '门诊人次去重规则' }).click();
    await snap(page, '31', '知识与偏好', '知识与偏好-待我审核');
    await page.getByRole('button', { name: '我负责的知识', exact: true }).click();
    await page.locator('.management-resource').filter({ hasText: '住院费用统计口径' }).click();
    await snap(page, '32', '知识与偏好', '知识与偏好-我负责的知识');
  }, knowledgeFixture);
  await group('review', async (page, data) => {
    seedKnowledge(data);
    await goto(page, '/settings/knowledge');
    await page.locator('.management-resource').filter({ hasText: '门诊人次去重规则' }).click();
    await snap(page, '33', '知识审核', '知识审核-组织候选');
    await page.getByRole('button', { name: '正式知识管理', exact: true }).click();
    await page.locator('.management-resource').filter({ hasText: '下一统计周期费用口径' }).click();
    await snap(page, '34', '知识审核', '知识审核-正式知识管理');
  }, knowledgeFixture);
  await group('tasks', async (page, data) => {
    seedKnowledge(data);
    await goto(page, '/settings/tasks');
    await expect(page.getByText('MODEL_TIMEOUT', { exact: false })).toBeVisible();
    await snap(page, '35', '后台任务', '后台任务-状态列表');
  }, knowledgeFixture);
} finally {
  await browser.close();
  await stop();
  await saveManifest();
}
console.log(JSON.stringify({ screenshots: shots.size, failures, pageErrors }, null, 2));
if (failures.length || pageErrors.length) process.exitCode = 1;
