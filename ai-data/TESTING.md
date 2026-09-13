# 测试运行说明

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

运行入口为 `pnpm test:integration`，用例位于 [sqlserver.integration.ts](apps/data-access/tests/integration/sqlserver.integration.ts)。这些文件使用 `*.integration.ts` 命名，由专用 Vitest 配置收集。

需要一个专用 SQL Server 测试实例、可用的 SQL 登录，以及创建和删除测试数据库、执行测试库内 DDL 的权限。真实 DAS 驱动启用加密并验证服务器证书，测试实例需提供受信任的证书，主机名需与证书匹配。

1. 复制 [示例配置](apps/data-access/config/sqlserver.test.config.example.json) 为同目录的 `sqlserver.test.config.local.json`，填写测试实例连接信息。该本地文件已加入 Git 忽略规则。
2. 管理连接的 `database` 保持 `master`。配置仅包含 SQL Server 连接字段；不需要 API 密钥或业务服务配置。
3. 设置配置路径并运行：

```powershell
$env:SQLSERVER_TEST_CONFIG = (Resolve-Path 'apps/data-access/config/sqlserver.test.config.local.json').Path
pnpm test:integration
```

入口会创建三个 `ai_data_test_<本轮随机标识>_api|das|rollback` 数据库。API 与 DAS 的实际迁移分别在独立数据库运行；查询用例通过真实 DAS SQL Server 驱动执行。测试结束后关闭连接池，并删除本轮成功创建的库和临时迁移目录。

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

2026-09-12：已验证集成入口能加载并在缺少配置时给出明确错误。当前没有专用 SQL Server 环境，11 个数据库集成用例尚未实跑。完整交付证据见 [S-05](../需求文档/code-organization-review.md#s-05提高测试行为可信度自动检查明确约定)。
