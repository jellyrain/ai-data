# 测试运行说明

## 模型统一数据库配置验收（2026-09-21）

普通与工程测试 1221 项通过：API 581、DAS 409、contracts 168、metadata 28、工程 35。API SQL、确定性对话及构建启动 70 项通过，真实模型专项 1 项按既定调优安排跳过。Windows x64 发布专项另有 1 项通过，使用真实官方 app-server、本机固定 Responses 夹具及隔离 SQL。

四个受检包类型检查、全工作区 ESLint、API 构建及本轮文件格式检查通过。项目与发布的实际配置通过 Schema 校验，发布 API 与最新构建哈希一致。全量格式检查仅有既存 `pnpm-lock.yaml` 差异，锁文件保持原样；交接文档本地文件链接和 `git diff --check` 通过。

新增配置场景先确认预期失败，再实现运行参数独立于模型启动。覆盖旧字段拒绝、空模型与 Agent 清单、发布后创建会话、SQL 凭据加密、服务重建后读取固定版本、官方进程无初始模型启动及按请求使用认证。发布专项先通过管理接口发布模型与默认 Agent，再执行 API → DAS → SQL，更新后核对实际配置、密钥和完整状态目录的哈希，并恢复同一官方线程。

发布专项初次复验发现夹具整体复制来源目录时带入实际配置，配置保留断言失败。已按部署文件清单复制程序资源和示例，复验通过，隔离资源正常清理。真实模型专项改为只读已有数据库的模型与 Agent，再复制到验收库；本轮未调用真实模型服务。交付与流程图见[模型数据库配置交付说明](../任务交接/模型数据库配置交付说明.md)。

## API 与 DAS 发布验收（2026-09-21）

普通及工程测试 1214 项通过：API 574、DAS 409、contracts 168、metadata 28、工程 35（新增打包测试 20）。API、DAS、contracts、metadata 类型检查、全工作区 ESLint 与两应用构建通过。发布专项另有 1 项完整链路通过。

`pnpm test:release` 或 `node scripts/test-release.mjs` 在工作区根目录执行，要求先构建当前平台发布目录。默认读取 API 本地 SQL 配置，或由 `SQLSERVER_TEST_CONFIG` 指定；需要创建、删除随机隔离库的权限。专项复制两个发布包到系统临时目录，核对实际外置依赖路径及链接，验证生产入口首建、API 登录、DAS 注册、凭据和来源管理、真实查询与审计、官方 app-server 的 Skill/函数协议、程序更新后状态保留及同线程恢复。模型响应由本机固定 Responses 夹具提供。普通测试及默认 SQL 集成不收集发布专项。

当前 `win32-x64` 完成实机验收。其他五个目标完成平台选择规则测试，完整产包与运行仍需在对应环境执行。Windows 夹具用 `taskkill /T` 结束自身进程树；当前沙箱禁止该操作，最终专项在沙箱外通过，受限尝试的隔离库和临时目录已清理。全工作区 Lint 应在普通测试的临时目录清理后执行。

本轮文件单独做格式检查；全量格式检查沿用既有 `pnpm-lock.yaml` 差异记录。部署步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)，变更与流程图见[打包交付说明](../任务交接/API与DAS多平台打包交付说明.md)。

## 第 9 步统一报表验收（2026-09-21）

普通及工程测试 1194 项通过：API 574（74 个文件）、contracts 168、metadata 28、DAS 409、工程 15。API SQL、确定性对话与构建启动共 70 项通过；DAS SQL 与首建回滚 32 项通过，合计 102 项。真实模型用例 1 项按用户既定调优安排跳过。最后的执行操作键与参数边界修正后，统一报表端到端 6 项再次通过，重复执行不增加上述用例数量。

新增验收入口：

| 文件                                                          | 覆盖                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/tests/integration/report-flow.integration.ts`       | 真实 API→DAS→SQL，HTTP 创建、二次编辑、按参数执行、幂等、多查询、分享撤销、对话暂存/冲突/取消、旧工具转换、说明与模板发布，6 项 |
| `apps/api/tests/integration/report-management.integration.ts` | 定义与快照双版本、来源完成状态、块、分享和导出，4 项                                                                            |
| `apps/api/tests/integration/catalog-relations.integration.ts` | 独立关系发布、整批回滚、完整配置兼容及入向唯一键约束，5 项                                                                      |

新增领域测试覆盖关系图、参数和引用校验、指标固定版本恢复、模型不可用时执行、整次预算、迟到结果、旧说明归属、长查询标识、对话完成事务和模板审核；合同测试验证结构与引用边界。先验证新增行为的预期失败，再补实现并回归。

四包类型检查、工作区 ESLint、工程规则及两应用构建通过。本轮文件和文档格式检查通过；全工作区 `format:check` 仍报告进入本轮前已有的 `pnpm-lock.yaml` 格式问题，锁文件未修改。`git diff --check` 与文档链接检查通过。

沿用已安装 CLI。在 `apps/api` 目录执行专项：

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/report-flow.integration.ts tests/integration/report-management.integration.ts tests/integration/catalog-relations.integration.ts
```

统一报表测试启动当前 DAS 构建产物，执行真实签名 HTTP 查询；API 元数据连接池限制为 1，以验证完成事务内复用连接。全 API SQL 与构建启动去掉文件筛选；构建启动测试需要当前 API `dist/index.js`。DAS 集成需要设置 `SQLSERVER_TEST_CONFIG` 为本地连接配置路径，本次首次缺少该变量时在建库前失败，设置后 32 项全部通过。

所有 SQL 验证在随机隔离库执行，已清理测试库、临时配置与进程。现有开发库未重建，依赖未安装或变更。界面交互与 Excel、Word、PDF 文件生成按 Web 阶段验收；接口与本次流程分别见[统一报表](REPORTS.md)和[第 9 步交付说明](../任务交接/第9步交付说明.md)。

## 第 10 步知识与记忆验收（2026-09-20）

普通及工程测试 1145 项通过：API 534（64 个文件）、contracts 159、metadata 28、DAS 409、工程 15。SQL 与确定性对话合计 55 项通过：原 API SQL 27、偏好 6、知识 6、记忆事件/会话衔接 11、确定性对话 4、构建启动与功能验收 1；真实模型用例 1 项按用户既定安排跳过。首建及失败回滚专项 4 项通过，28 项未选中的 DAS 测试不计入专项。

新增场景覆盖自动保存、跨账号隔离和跨会话读取、相对时间跨年、习惯计数及停用、确认与恢复事务、候选审核发布及回滚、租约接管、后台失败和关闭恢复。API 构建产物验证登录、Agent 会话、偏好保存读取、知识审核发布和后台管理接口。当前业务首建在原 37 张表基础上增加第 10 步 15 张表，仍统一在 `001`。

相关包类型检查、工作区 ESLint 和 API 构建通过。完整格式检查保留既有 `pnpm-lock.yaml` 差异，本轮文件单独检查。SQL Server 事务并发读取问题已通过串行适配修复；Windows 临时 SQLite 清理占用加入有限重试后通过。最终 API 普通测试按项目单 Worker 配置通过。详细交付与流程图见[第 10 步说明](../任务交接/第10步交付说明.md)。

在 `apps/api` 目录使用现有 CLI 复跑本阶段 SQL：

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/preferences.integration.ts tests/integration/knowledge.integration.ts tests/integration/memory-events.integration.ts
```

全体 API SQL、确定性对话及构建启动使用同一命令去掉文件筛选。启动验收需先生成当前 API `dist/index.js`；真实模型仅在显式设置 `LOCAL_MODEL_ACCEPTANCE=1` 时执行。

## API 首建迁移整合验收（2026-09-20）

API 现保留 `000_schema_migrations.sql` 和 `001_initial_api_schema.sql`，业务首建包含原 `001` 至 `009` 的全部 37 张表及最终字段、约束和索引。原业务迁移文件已合并，使用旧基线的开发库需另行重建。

本轮迁移发现测试 1 项、迁移 SQL 专项 4 项、API SQL 业务集成 27 项、构建产物启动 1 项通过。迁移专项验证空库首建、重复执行保持数据和版本，以及 API、DAS 提交前注入失败后的完整回滚和重跑；未选中的 28 项 DAS 查询测试不计入本轮结果。API 与 DAS 类型检查、修改测试的 ESLint、API 构建、相关格式检查及 `git diff --check` 通过。

当前开发库未重建，隔离验收资源已清理。流程与改动清单见[API 首建迁移整合](../任务交接/API首建迁移整合说明.md)。

## 600 秒预算真实模型复验（2026-09-20）

按用户指定的 600 秒，将本地 `analysis_runtime.timeout_ms` 修正为 600000 毫秒。模型验收夹具使用配置原值，单条测试时限按“两轮预算加 60 秒”计算，本次为 1260 秒。API 类型检查、这两个测试文件的 ESLint 与格式检查通过。

真实模型用例约 306 秒后失败，错误为 `QUERY_LIMIT_EXCEEDED`：模型读取关系查询和过滤条件说明、核对目录后，反复对普通表提交 `parameterized_query`，工具持续返回“对象不支持参数化查询”；达到配置中的 30 次工具调用预算后被终止。此次未取得有效统计结果，未进入最终答复与重启追问验证。测试结果为 1 项失败、4 项未选中跳过，资源已清理。

600 秒时限已生效。只读核查确认项目生成的工具 Schema 同时包含 `relational_query` 与 `parameterized_query`，官方线程历史也记录了工具拒绝结果；重复选择错误分支的具体原因仍待定位。此次未调整工具次数、业务 Skill 或验收断言。

## 用户重启模型后的真实模型复验（2026-09-20）

用户重启本地模型后，使用当前加密入库实现和原验收用例复跑，结果为 1 项失败、4 项未选中跳过。模型成功读取目录及关系查询说明，并使用 `relational_query` 查询；前面多次请求遗漏日期条件，得到 A 科室 3 人次。最后在 `from.filters` 中补充 2026-09-01 至 2026-09-30 后，工具返回正确的 A 科室 2 人次。

整轮仍在 180 秒预算结束时返回 `QUERY_TIMEOUT`，没有完成最终答复，未进入进程重建后同线程追问断言。此次实际调用已走模型凭据加密存库、运行解密及官方工具链路；取得正确查询结果不等于完整业务验收通过。未调整代码、Skill、预算或测试断言。测试套件正常完成清理。

## 模型凭据加密入库验收（2026-09-20）

普通及工程测试共 1078 项通过：工程 15、contracts 150、metadata 28、API 476、DAS 409。共享加密器和主密钥库的 4 项测试从 DAS 移到 metadata。API SQL 集成 27 项、确定性对话 4 项、构建启动 1 项及 DAS SQL 集成 31 项通过，共 63 项。

模型服务 7 项测试覆盖密文持久化、公开脱敏、按版本读取、随机 IV、重建服务恢复、无认证版本、错误/缺失主密钥、密文篡改以及权限边界。真实 SQL 验证凭据与配置同版本保存，并发冲突不覆盖成功发布的凭据，重建服务可恢复认证。官方 app-server 使用模拟 Responses 的认证协议测试通过。加密修改完成时未重跑真实模型业务验收；随后用户重启模型后的复验见本文开头。

类型检查、ESLint、API/DAS 构建、本轮文件格式和 `git diff --check` 通过。全量格式检查仍有既有锁文件问题。具体改动和流程图见[模型凭据加密入库](../任务交接/第8步模型凭据加密入库.md)。

## 第 8 步 Agent 框架验收（2026-09-20）

普通及工程测试 1073 项通过：工程 15、contracts 150、metadata 24、API 471（51 个文件）、DAS 413。API SQL 集成 27 项、确定性 API → DAS → SQL 对话 4 项、构建产物启动 1 项、DAS SQL 集成 31 项通过。工作区类型检查、ESLint、API/DAS 构建、本轮文件格式及 `git diff --check` 通过。

根目录全量格式检查仅报告既有 `pnpm-lock.yaml` 格式差异：已核对其内容与 HEAD 一致，HEAD 内容也无法通过当前 Prettier。该锁文件保持原样。本轮另同步了 DAS 集成测试中的 API 迁移清单，补齐 `007`–`009` 后 31 项通过。

新增场景包括 Agent/模型版本并发发布、管理权限及组织隔离、公开认证脱敏、重复启动迁移、会话固定版本、历史会话首次绑定、源 Skill 更新后旧版本保持原内容、缺失/篡改资源拒绝，以及运行读取接口返回配置关联。确定性对话新增 Agent 选择工具后查询授权 A 科室 2 人次，并校验运行版本和 DAS 审计。

`agent-protocol.test.ts` 使用实际官方 app-server 与本机模拟 Responses：验证不同模型及认证、两个 Agent 并发、共享版本目录中的独立线程、Skill 发现与正文隔离、空 Skill/工具、进程重建后同线程恢复及入口只注入一次。`agent-harness.test.ts` 的子进程夹具验证同 PID 复用、认证变更排空重建和等待取消。

**第 8 步框架初次交付时，真实本地模型完整业务验收未通过。** 首次沙箱连接返回 `EACCES` 并超时。沙箱外能执行工具，一次结果未满足 A 科室 2 人次断言；补充诊断后复跑，模型读取关系查询子文档，仍反复对普通表提交 `parameterized_query`，被 API 以 `UNSUPPORTED_QUERY` 拒绝，180 秒后超时。该次未进入重启追问断言。随后复验结果见本文开头；完整说明与流程图见[第 8 步交付说明](../任务交接/第8步交付说明.md)。

复跑新集成场景，在 `apps/api` 目录使用已安装 CLI：

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/agents.integration.ts tests/integration/agent-runtime.integration.ts tests/integration/dialogue.integration.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/agent-startup.integration.ts
```

启动用例和对话用例分别需要最新 API、DAS 构建产物。所有资源使用随机临时目录和隔离库，清理钩子关闭进程并删除测试资源。真实模型仍使用下节的显式 `LOCAL_MODEL_ACCEPTANCE=1` 入口，现已接入固定 Agent 版本及独立 Skill 目录。

## 第 7 步收尾复验（2026-09-20）

API 普通测试 416 项（42 个文件）、SSE 合同 9 项、API SQL 集成 18 项、确定性对话 3 项、实际本地模型对话 1 项通过。API 类型检查与 ESLint、API 和 DAS 的类型构建检查及实际构建通过。

实际 `rj-model-v1` 成功按需读取关系查询子文档，查询获得授权 A 科室 2 人次；关闭并重建 Harness 后恢复同一官方线程，追问得到 3，第二轮没有新增 SQL 查询。测试清理钩子正常完成。首次沙箱内访问模型返回 `EACCES` 并导致无工具调用的超时；沙箱外健康检查及同一真实模型用例通过。此处为最新结论，下文保留历史记录。说明与流程图见[第 7 步交付记录](../任务交接/第7步常驻运行与状态推送.md)。

在 `apps/api` 目录用已安装的 CLI 复跑真实模型场景：

```powershell
$env:LOCAL_MODEL_ACCEPTANCE = '1'
try {
  node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/dialogue.integration.ts -t '本地模型通过普通函数'
} finally {
  Remove-Item -LiteralPath Env:\LOCAL_MODEL_ACCEPTANCE
}
```

## 常驻运行与压缩状态复验（2026-09-15）

本轮 API 全量普通测试 404 项（41 个文件）通过。SSE 合同 9 项通过。真实官方运行时协议用例验证两份 Skill、普通函数及工具错误进入后续模型请求。API SQL 集成 18 项、确定性对话 3 项通过。API 与共享合同类型检查、ESLint、API 构建、本轮文件格式及 `git diff --check` 通过。

实际本地模型完整对话复验未通过：模型完成目录发现后反复对普通关系表提交 `parameterized_query`，API 返回 `UNSUPPORTED_QUERY`，180 秒后超时；此次未执行到重启后追问。保留原验收问题、业务 Skill 与模型配置。下节为初次接入的历史结果，不能代替此次复验。实现与前台展示约定见[交付说明](../任务交接/第7步常驻运行与状态推送.md)。

定向检查直接使用已安装的 CLI；API 目录下执行：

```powershell
node node_modules/vitest/vitest.mjs run --pool=threads --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js .
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/analysis.integration.ts tests/integration/dialogue.integration.ts
```

设置 `LOCAL_MODEL_ACCEPTANCE=1` 后按下方真实模型命令单独复验。官方运行时测试目录位于项目启动目录的 `secrets` 下，测试结束关闭模型进程并删除本轮状态。

## 官方 Codex Harness 验收（2026-09-15）

本轮使用项目官方 Codex 0.154.0 app-server 与普通函数。API SQL 集成 18 项、确定性对话 3 项及实际本地模型对话 1 项通过。实际模型取得授权 A 科室 2 人次；重启后同一官方线程沿用结果回答 3，第二轮未再次查询数据库。API 构建产物使用隔离库和临时配置、启用运行时，启动后 /health 返回 200，资源已清理。

API 普通测试 391 项（40 个文件）通过，包含 13 项子进程协议场景及 1 项真实官方运行时的 Skill/函数请求验证。类型检查、ESLint、API 构建与本轮文件格式检查通过；`git diff --check` 通过。DAS 本轮复用已有构建产物，由上述真实 HTTP 对话场景验证。下方 2026-09-14 记录描述此前实现，不作为官方 Harness 的验收证据。

所有命令在仓库中的 `ai-data/` 工作区根目录执行。

## 默认验证

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

`pnpm test` 先运行工程规则测试，再运行各包的 Vitest 测试。默认测试使用本地数据、临时文件和驱动替身，不依赖 SQL Server。包级测试仍可独立执行：

```powershell
pnpm --filter @ai-data/metadata test
pnpm --filter @ai-data/data-access test
pnpm test:engineering
```

数据库替身需要遵守生成 SQL 的行数限制和真实驱动的数据合同。关系查询以返回上限 N 加一行探测截断，固定存储过程按实际返回结果集裁剪；两者均覆盖空结果、少于、等于及超过上限的情况。

## SQL Server 集成验证

运行入口为 `pnpm test:integration`，执行 [API 运行与业务验收](apps/api/tests/integration/analysis.integration.ts)、[对话链路验收](apps/api/tests/integration/dialogue.integration.ts) 和 [DAS 驱动验收](apps/data-access/tests/integration/sqlserver.integration.ts)。这些文件使用 `*.integration.ts` 命名，由专用 Vitest 配置收集。对话套件使用已构建的 DAS 产物，首次运行或源码变更后先构建相关应用。

需要可用的 SQL Server 实例、SQL 登录，以及创建和删除临时数据库、执行测试库内 DDL 的权限。测试连接遵循配置中的加密和证书选项；DAS 驱动默认启用加密并验证服务器证书。

1. 复制 [示例配置](apps/data-access/config/sqlserver.test.config.example.json) 为同目录的 `sqlserver.test.config.local.json`，填写测试实例连接信息。该本地文件已加入 Git 忽略规则。
2. 管理连接的 `database` 保持 `master`。配置仅包含 SQL Server 连接字段；不需要 API 密钥或业务服务配置。
3. 设置配置路径并运行：

```powershell
$env:SQLSERVER_TEST_CONFIG = (Resolve-Path 'apps/data-access/config/sqlserver.test.config.local.json').Path
pnpm --filter @ai-data/api --filter @ai-data/data-access build
pnpm test:integration
```

API 入口创建一个 `ai_data_api_test_<随机标识>` 数据库；DAS 入口创建 `ai_data_test_<本轮随机标识>_api|das|rollback` 数据库，API 迁移回滚场景另建同一前缀的 `apirollback` 库。API 与 DAS 的实际迁移在隔离数据库运行；DAS 查询用例通过真实 SQL Server 驱动执行。测试结束后关闭连接池，并删除本轮成功创建的库和临时迁移目录。

也可将 `SQLSERVER_TEST_CONFIG` 指向本地 `apps/data-access/config/das.config.json` 或 `apps/api/config/api.config.json`。入口提取 `metadata_sqlserver` 连接信息并将管理连接切换为 `master`，在独立临时库执行测试。

| 场景                                         | 预期                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| API、DAS 首次迁移                            | 建立业务表并登记对应迁移版本                                   |
| API、DAS 重复迁移                            | 版本及其时间保持一致，已写入业务数据保持一致                   |
| 实际 API、DAS 首建在提交前注入失败           | 本文件的全部业务表和版本标记回滚，后续迁移停止，修复后可以重跑 |
| 真实关系查询返回 0、1、2、3 行，上限为 2     | 最多返回 2 行，仅有第 3 行时报告截断                           |
| 真实固定存储过程返回 0、1、2、3 行，上限为 2 | 按绑定参数查询并正确裁剪结果、报告截断                         |

迁移事务由各 SQL 文件定义；失败场景检查文件级事务边界，先前成功迁移的版本登记表仍保留。

缺少配置、配置无效或连接失败会使集成命令以非零状态退出。若进程被强制终止，清理钩子可能来不及运行；重新连接专用实例后，按本轮随机标识核对遗留数据库再清理。清理报错会给出对应库名。

## 当前验证记录

2026-09-14 模型运行时与目录管理验收：API 普通测试 390 项、DAS 普通测试 413 项通过。SQL 与链路验收共 51 项通过：API 16、DAS 31、确定性对话 3、实际本地模型对话 1。API 集成包含策略并发版本、报告保存原子去重及取消拒绝保存；对话范围及复跑方式见下节。

相关类型检查、ESLint、API/DAS 构建及格式检查、`git diff --check` 通过，运行时、Harness 和报告相关 34 项回归通过。DAS SQL 31 项与确定性对话 3 项均已按最新 DAS 构建产物复跑通过。

部署启动检查另已通过：API、DAS 的正式 `pnpm build` 脚本均成功；API 使用独立隔离数据库、临时配置和已启用的 `analysis_runtime`，由 `node dist/index.js` 启动后 `/health` 返回 200。进程、临时配置和测试库已清理。该检查单独记录，SQL 与链路验收仍计 51 项。

## 对话链路验收

先按上节设置 `SQLSERVER_TEST_CONFIG` 并完成 API、DAS 构建。对话入口使用真实 Fastify API 路由与运行服务，发送带 JWT 和整体签名的 HTTP 请求到独立 DAS 进程。DAS 由 `node` 直接运行实际 ESM 构建产物，使用真实目录、规划器、编译器、SQL Server 驱动和审计仓储。测试在随机隔离数据库创建样本和配置，结束时关闭进程、连接并清理本轮资源。

默认执行 3 项脚本化模型 Harness 场景：

```powershell
pnpm --filter @ai-data/api exec vitest run --config vitest.integration.config.ts tests/integration/dialogue.integration.ts
```

这 3 项验证澄清回答恢复同一运行、两次 SQL 查询形成证据与最终答案、重试复用已提交证据、追问加载已授权上下文，以及两个角色的数据范围与会话/事件归属。A、B 部门各有 2 人次，跨部门去重总计为 3；受限角色仅可查看 A 部门。

完整本地模型验收需在 `apps/api/config/api.config.json` 中启用 `analysis_runtime`，并已通过管理接口在该配置连接的数据库中发布模型与 Agent，保留匹配的状态目录和模型主密钥。默认读取初始化组织的 `default` Agent；可用 `LOCAL_MODEL_ORGANIZATION_ID` 和 `LOCAL_MODEL_AGENT_ID` 指定已有配置。模型地址使用回环地址或私有 IPv4 地址；Agent 需绑定生产查询 Skill 与查询工具。源配置仅用于读取，验收将模型与 Agent 复制到隔离库。配置字段与部署要求见[模型运行时说明](MODEL-RUNTIME.md)。显式运行该场景：

```powershell
$env:LOCAL_MODEL_ACCEPTANCE = '1'
pnpm --filter @ai-data/api exec vitest run --config vitest.integration.config.ts tests/integration/dialogue.integration.ts -t '本地模型通过普通函数'
Remove-Item -LiteralPath Env:\LOCAL_MODEL_ACCEPTANCE
```

该入口使用项目官方 Codex app-server 和数据库中的固定 Agent 配置，Skill 从隔离验收库发布的 Agent 独立版本目录加载；每轮运行预算读取 Agent 的 `limits.timeout_ms`。整个测试上限为两轮预算加 60 秒装配收尾时间；配置为 600000 毫秒时，每轮最多 600 秒，整个用例最多 1260 秒。断言目录核对、当前权限内的日期过滤与去重统计，A 科室为 2 人次，并留下 SQL 证据和工具审计；重启后恢复同一官方线程，沿用结果回答加 1 为 3。

实际模型场景与三个确定性场景分别记录，结果见本文件最新验收记录。模型测试使用隔离样本；第 7 步范围见[实现审查](../需求文档/implementation-review.md)。

## 结果交付验收基线

2026-09-14：单元与工程测试通过 919 项（工程 15、contracts 145、metadata 24、API 327、DAS 408）；类型检查、ESLint、两应用构建及根格式检查通过。

2026-09-14：使用本地 config 的 SQL Server 连接完成隔离验收，API 12 项、DAS 31 项全部通过。本轮创建的测试库和临时迁移目录已由清理钩子删除。

API 验证消息与运行原子提交、并发幂等、跨用户隔离、租约接管、澄清恢复、证据回滚、部门权限、指标版本和报告分享。隔离样本中 A、B 部门分别 2 人次，跨部门去重总计为 3；A 部门角色总计为 2；两组比率为 20 和 9，总比率为 130/12。业务查询使用真实授权及限定样本模板的 SQL 适配器，DAS 编译执行由另一组集成测试验证。

DAS 验证迁移、关系查询与存储过程截断、两层 AVG、带值 ON、数值/日期时间/布尔/二进制/null/空结果、超时、取消及连接复用，并验证成功、拒绝、取消、失败审计落库。拒绝和执行失败的注入点使用替身，审计仓储使用真实 SQL Server。

接口与统计口径见 [分析运行说明](ANALYSIS-RUNTIME.md)。其他数据库的真实驱动兼容性仍需对应测试环境。

## 明细交付验收

[交付与导出设计](../需求文档/result-delivery-and-export.md)定义当前 API/DAS 合同及后续 Web 行为。新测试覆盖：

- `POST /query` 一次交付 50,000 行，空结果为完整零行，截断结果的 `delivery.total_row_count` 为 `null`。
- 查询结束时重新核对身份与授权；会话失效或授权 DSL 变化时，不返回已取得的结果。
- SQL Server 生产 HTTP 查询链路验证签名、规划、执行、脱敏和审计；隔离表含 50,000 行，A/B 部门各 25,000 行。
- SQL Server 逐行保留结果与一行截断探针，数据源配置和请求上限分别生效；UTF-8 原始行和标准化表格 JSON 的容量拒绝均验证后续连接复用。
- API 的 DAS HTTP 响应大小限制、运行证据容量、SSE 样本范围，以及缺省行数归一化后的查询/指标重试。

明细交付用例分别在各自套件验收：API 业务集成使用限定 SQL 适配器；DAS 集成使用实际 HTTP 路由到 SQL Server 的执行链。完整对话链路使用本说明的对话套件验收。Web 分页、文件生成及浏览器性能在 Web 阶段按设计另行验收。
