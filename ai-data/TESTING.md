# 测试运行说明

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

API 入口创建一个 `ai_data_api_test_<随机标识>` 数据库；DAS 入口创建三个 `ai_data_test_<本轮随机标识>_api|das|rollback` 数据库。API 与 DAS 的实际迁移在隔离数据库运行；DAS 查询用例通过真实 SQL Server 驱动执行。测试结束后关闭连接池，并删除本轮成功创建的库和临时迁移目录。

也可将 `SQLSERVER_TEST_CONFIG` 指向本地 `apps/data-access/config/das.config.json` 或 `apps/api/config/api.config.json`。入口提取 `metadata_sqlserver` 连接信息并将管理连接切换为 `master`，在独立临时库执行测试。

| 场景                                         | 预期                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| API、DAS 首次迁移                            | 建立业务表并登记对应迁移版本                               |
| API、DAS 重复迁移                            | 版本及其时间保持一致，已写入业务数据保持一致               |
| 实际 DAS 迁移在提交前注入失败                | 本文件的业务表和版本标记回滚，后续迁移停止，修复后可以重跑 |
| 真实关系查询返回 0、1、2、3 行，上限为 2     | 最多返回 2 行，仅有第 3 行时报告截断                       |
| 真实固定存储过程返回 0、1、2、3 行，上限为 2 | 按绑定参数查询并正确裁剪结果、报告截断                     |

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

完整本地模型验收另需在 `apps/api/config/api.config.json` 中启用有效的 `analysis_runtime`，当前提供方使用回环地址或私有 IPv4 地址。配置字段与部署要求见[模型运行时说明](MODEL-RUNTIME.md)。显式运行该场景：

```powershell
$env:LOCAL_MODEL_ACCEPTANCE = '1'
pnpm --filter @ai-data/api exec vitest run --config vitest.integration.config.ts tests/integration/dialogue.integration.ts -t '本地模型通过普通函数'
Remove-Item -LiteralPath Env:\LOCAL_MODEL_ACCEPTANCE
```

该入口使用项目官方 Codex app-server、当前提供方和全部业务函数。两份生产 Skill 由官方运行时加载；每轮超时取配置与 180 秒的较小值，整个测试上限 240 秒。断言目录核对、当前权限内的日期过滤与去重统计，A 科室为 2 人次，并留下 SQL 证据和工具审计；重启后恢复同一官方线程，沿用结果回答加 1 为 3。

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
