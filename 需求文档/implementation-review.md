# 实现与需求符合性审查

审查日期：2026-09-11  
状态：问题待逐项处理  
代码范围：`../ai-data/packages/contracts`、`../ai-data/packages/metadata`、`../ai-data/apps/data-access`；API 仅检查与这些模块相关的衔接。  
关联文件：[代码写法与文件组织审查](./code-organization-review.md)

## 1. 审查结论与依据

基础目录、共享合同、元数据库访问、连接器与执行映射已经具备。当前实现尚未完整满足设计基线，DAS 存在已复现的脱敏、认证及查询结果问题；审计和部分执行能力仍待接入。API 处于开发中，其授权衔接问题单独记录。

本文件保存审查时的代码快照结论。后续处理每项问题时，应先核对最新实现，再补充验证证据和更新状态。

依据：[contracts.md](./contracts.md)、[data-access-design.md](./data-access-design.md)、[das-implementation-plan.md](./das-implementation-plan.md)、[api-implementation-plan.md](./api-implementation-plan.md)、[development-standards.md](./development-standards.md)。DAS 实施方案第 6 步标为“核心已完成”，第 7 步执行与审计尚未标为完成；新增合同要求也明确列为待验收。

| 模块        | 现状                                             | 验收判断                                     |
| ----------- | ------------------------------------------------ | -------------------------------------------- |
| contracts   | 基础目录、查询、权限、结果和 SSE 合同已实现      | 新增合同未齐，已有 Schema 存在校验缺口       |
| metadata    | 独立连接池、参数化执行、健康检查和迁移加载已实现 | 基础职责具备，测试验收不足                   |
| data-access | 连接器、目录、白名单映射、查询执行和脱敏已有实现 | 部分满足，存在阻塞验收的问题                 |
| api         | 已有目录、授权、签名和 DAS Client                | 按开发中跟踪，相关授权场景须在开放查询前验收 |

## 2. 问题索引与处理规则

P1 表示优先处理的权限、敏感数据或关键查询正确性问题；P2 表示功能完整性、结果合同和可靠性问题。“待确认”表示文档与代码约定需要先统一。所有条目当前保持未完成；每次处理应记录修改内容、验证结果和剩余限制。

| 编号 | 优先级 | 范围                  | 问题                                 | 状态         |
| ---- | ------ | --------------------- | ------------------------------------ | ------------ |
| R-01 | P1     | DAS                   | 部分脱敏在末尾保留 0 位时泄露原文    | 待处理       |
| R-02 | P1     | DAS / API             | 内部管理、目录和心跳通道认证不足     | 待处理       |
| R-03 | P1     | DAS                   | 授权有效期和 JWT 必需字段校验不完整  | 待处理       |
| R-04 | P2     | DAS                   | 审计仓储未接入请求执行链             | 待处理       |
| R-05 | P2     | DAS                   | 数据库结果截断状态不准确             | 待处理       |
| R-06 | P2     | DAS                   | 结果类型与可空性未完整标准化         | 待处理       |
| R-07 | P2     | DAS                   | 存储过程目录与 HTTP 输入参数定义不足 | 待处理       |
| R-08 | P2     | DAS                   | 超时、取消、排队与成本限制未完整落地 | 待处理       |
| R-09 | P2     | contracts / API / DAS | v0.2 新增合同与执行能力待补齐        | 计划内待实现 |
| R-10 | P2     | contracts             | SSE 严格校验和查询结果一致性校验不足 | 待处理       |
| R-11 | P2     | metadata              | 包测试命令因没有测试文件失败         | 待处理       |
| R-12 | 待确认 | DAS / 文档            | 元数据库密码的配置约定不一致         | 待讨论       |
| R-13 | P1     | API                   | 外连接可选侧行权限仍写入 WHERE       | 开发中待处理 |
| R-14 | P1     | API                   | 行策略求值、操作符与多角色合并不完整 | 开发中待处理 |
| R-15 | P1     | API                   | 参数化查询的行列权限和脱敏未落实     | 开发中待处理 |
| R-16 | P1     | API                   | 组合关联只校验提交条件的子集         | 开发中待处理 |

## 3. 问题详情

### R-01 部分脱敏在末尾保留 0 位时泄露原文

- [ ] 完成修复与验收。
- **要求**：按已签名的 `output_masks` 对字符串结果执行部分脱敏。
- **现状与证据**：`suffix_length: 0` 通过合同校验，执行时 `slice(-0)` 返回完整字符串。使用合成手机号 `13800138000`、前缀 3 位、后缀 0 位，实际得到 `138********13800138000`，预期为 `138********`。已执行内存最小复现。
- **位置**：[result-masker.ts](../ai-data/apps/data-access/src/query-execution/result-masker.ts)，第 37 行；[output-mask.ts](../ai-data/packages/contracts/src/query/output-mask.ts)。
- **影响**：合法脱敏配置会将敏感原文包含在返回值中。
- **验收**：覆盖后缀 0 位、前后缀均 0 位、短字符串、空字符串和 null；返回值仅包含配置允许保留的字符。

### R-02 内部管理、目录和心跳通道认证不足

- [ ] 完成调用方认证与验收。
- **要求**：DAS 内部接口由受信任 API 调用，心跳沿用服务间认证边界。
- **现状与证据**：查询路由有验签；管理和目录路由直接进入业务处理，应用未注册覆盖这些路由的统一认证。使用模拟管理服务发起无 Authorization 的请求，处理函数被调用并返回 200。DAS 心跳发送和 API 接收链也未包含服务身份验证。
- **位置**：[管理路由](../ai-data/apps/data-access/src/routes/data-source-management-route.ts)，第 29 行；[目录路由](../ai-data/apps/data-access/src/routes/catalog-route.ts)；[DAS 启动与心跳](../ai-data/apps/data-access/src/index.ts)；[API 心跳接收](../ai-data/apps/api/src/routes/data-access-routes.ts)。
- **影响**：能够访问端口的调用方可以进入配置操作或目录读取；未认证心跳可影响服务登记。实际暴露范围取决于部署网络配置。
- **验收**：缺失、无效、过期及错误受众的服务凭证在业务处理前被拒绝；有效凭证可完成对应操作；心跳身份与获准实例绑定。管理用户授权仍由 API 负责。

### R-03 授权有效期和 JWT 必需字段校验不完整

- [ ] 完成短时授权验证与验收。
- **要求**：验证 JWT 的签名、签发方、受众和规定 claims，并拒绝过期的访问上下文。
- **现状与证据**：验签器未检查 `access.expires_at`，也未强制要求 `exp`、`iat`、`nbf`、`jti` 存在。使用临时测试密钥，已复现“有效 JWT + 已过期 access”通过验证，以及缺少这些字段的已签名 JWT 通过验证。测试未使用项目真实私钥。
- **位置**：[internal-query-verifier.ts](../ai-data/apps/data-access/src/auth/internal-query-verifier.ts)，第 28 行。
- **影响**：请求签名正确时，访问上下文的短时授权窗口仍可能未被执行。
- **验收**：覆盖过期 access、缺失必需 claims、未到生效时间、过期 JWT、错误签发方/受众及篡改请求；验证失败时不进入连接器执行。

### R-04 审计仓储未接入请求执行链

- [ ] 接入审计并验收各结果路径。
- **要求**：成功、拒绝、超时和失败写入 `query_audit_logs`，保留可关联的用户、组织、运行和策略信息。
- **现状与证据**：`AuditRepository` 和数据库表已实现。查询服务只执行映射、连接器调用和脱敏，启动组装未注入审计仓储；源码检索未发现请求链对该仓储的调用。
- **位置**：[query-execution-service.ts](../ai-data/apps/data-access/src/query-execution/query-execution-service.ts)，第 19 行；[audit-repository.ts](../ai-data/apps/data-access/src/metadata/audit-repository.ts)。
- **影响**：仓储测试通过不能证明实际查询已被审计。
- **验收**：四类处理结果均产生可关联记录；早期认证拒绝只记录可信信息；日志与审计不包含不必要的敏感明文；审计写入失败的处理约定明确且有验证。

### R-05 数据库结果截断状态不准确

- [ ] 完成截断状态修复与验收。
- **要求**：`truncated` 准确说明是否因返回限制丢弃了可返回的结果行。
- **现状与证据**：SQL 先使用 `TOP N` / `LIMIT N` 等限制，执行后再判断驱动结果是否多于 N 行。用遵守 `TOP 2` 的模拟驱动和 3 行合成源数据复现：返回 2 行，`truncated` 仍为 false。已有测试让 `TOP 1` 返回 2 行，未模拟真实限制行为。
- **位置**：[sql-query-compiler.ts](../ai-data/apps/data-access/src/connectors/sql-query-compiler.ts)，第 39 行；[database-connector.ts](../ai-data/apps/data-access/src/connectors/database-connector.ts)，第 109 行；[连接器测试](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts)。
- **影响**：后续模型、图表或统计可能把受限结果视为完整结果。
- **验收**：覆盖结果数少于、等于和大于限制的情形；返回数量仍遵守上限。关系查询与固定参数化结果各自有准确的截断判断方案和测试。

### R-06 结果类型与可空性未完整标准化

- [ ] 完成驱动元数据、值转换和可空性验收。
- **要求**：结果按统一列类型和 JSON 表达返回，HTTP 字段遵守配置的类型及 nullable。
- **现状与证据**：MySQL、PostgreSQL、Oracle 驱动仅保留列名，未传递实际类型，连接器将缺少类型的列默认为 string。HTTP 字段映射直接返回原值，仅检查 undefined，未拒绝不可空字段的 null。使用模拟 HTTP 响应已复现 integer 列返回字符串 `"12"`、不可空字段返回 null。
- **位置**：[database-drivers.ts](../ai-data/apps/data-access/src/connectors/database-drivers.ts)，第 98、129、167 行；[http-api-connector.ts](../ai-data/apps/data-access/src/connectors/http-api-connector.ts)，第 157 行。
- **影响**：列描述与真实值不一致，影响后续类型校验、图表、计算和脱敏处理。
- **验收**：按各驱动实际类型信息映射；覆盖数值、布尔、日期时间、二进制、null 与空结果；HTTP 转换失败和非空约束违反时返回明确错误。

### R-07 存储过程目录与 HTTP 输入参数定义不足

- [ ] 补齐声明并验收参数化调用链。
- **要求**：目录提供固定输出列，以及真实输入参数类型、必填状态和默认语义。
- **现状与证据**：数据库目录 SQL 发现存储过程名称，但输出列与输入参数未发现或配置补齐；模拟其实际投影经过目录服务，得到 `columns: []`、`query_parameters: []`。HTTP 参数全部被声明为 string、非必填，映射元数据没有保存完整参数定义。
- **位置**：[SQL Server 目录](../ai-data/apps/data-access/src/connectors/dialects/sqlserver-dialect.ts)，第 33 行；[目录服务](../ai-data/apps/data-access/src/catalog/catalog-service.ts)；[HTTP 参数声明](../ai-data/apps/data-access/src/connectors/http-api-connector.ts)，第 88 行；[映射元数据](../ai-data/apps/data-access/src/metadata/metadata-records.ts)。
- **影响**：API 无法可靠完成参数校验、固定结果列授权及模型目录描述。
- **验收**：支持的参数化对象具有可验证的输入与固定输出定义；不能可靠发现的部分有受控配置方式；覆盖必填、默认值、类型错误、空结果和输出变化。各数据库按其真实调用及返回方式集成验证。

### R-08 超时、取消、排队与成本限制未完整落地

- [ ] 补齐资源限制并验收。
- **要求**：查询受数据源的超时、并发、排队和成本约束；取消能够传播到在途工作。
- **现状与证据**：已有并发闸门，但外层等待队列没有显式容量限制。MySQL 仅设置连接超时，Oracle 执行未接入配置的查询超时；查询链没有取消信号。`costLimit` 已保存，但未发现执行限制使用点。以上为静态检查结果。
- **位置**：[database-drivers.ts](../ai-data/apps/data-access/src/connectors/database-drivers.ts)；[database-connector.ts](../ai-data/apps/data-access/src/connectors/database-connector.ts)；[http-api-connector.ts](../ai-data/apps/data-access/src/connectors/http-api-connector.ts)；[query-planner.ts](../ai-data/apps/data-access/src/query-planning/query-planner.ts)。
- **影响**：慢查询和积压请求可能长时间占用连接、内存或运行资源。
- **验收**：用可控慢任务验证执行超时、排队拒绝、等待中取消、执行中取消及连接释放；成本配置有明确可执行语义，尚未支持的限制应在能力说明中准确呈现。

### R-09 v0.2 新增合同与执行能力待补齐

- [ ] 按对应阶段完成合同与场景验收。
- **要求**：见 [contracts.md](./contracts.md) 第 6.3.1、6.4、6.5 节。
- **现状**：共享查询结构仍以字段等值 Join 和基础聚合为主；对象预过滤、带值 ON 条件和复合聚合未补齐。业务配置的唯一键、关联基数、指标统计定义，以及运行恢复、指标版本、证据和报告范围等合同也未完整落实。
- **位置**：[query-dsl.ts](../ai-data/packages/contracts/src/query/query-dsl.ts)；[api-dataset.ts](../ai-data/packages/contracts/src/catalog/api-dataset.ts)；[sse-events.ts](../ai-data/packages/contracts/src/sse/sse-events.ts)。
- **影响**：基础 Schema 完成不等于新增设计场景可执行。此项属于文档已注明的计划内工作。
- **验收**：新增能力同时具备共享合同、API 生成与校验、DAS 执行及边界测试；暂不可正确表达的查询由 API 明确拒绝。指标、运行和报告合同按各自阶段验收，不将其业务规划职责转移给 DAS。

### R-10 SSE 严格校验和查询结果一致性校验不足

- [ ] 补齐已有合同的边界校验。
- **要求**：服务边界拒绝未知字段；查询结果行数和单元格与声明相符。
- **现状与证据**：SSE 事件根对象未使用 `.strict()`，额外字段会被接受并剥离。公共 `queryResultSchema` 接受行数与 rows 长度不一致、integer 列携带任意字符串或行内额外嵌套字段。以上均已通过 Schema 最小复现。DAS 内部结果 Schema 已校验行数一致，公共合同仍未同步该约束。
- **位置**：[sse-events.ts](../ai-data/packages/contracts/src/sse/sse-events.ts)，第 5 行；[query-result.ts](../ai-data/packages/contracts/src/query/query-result.ts)，第 15 行；[connector-result.ts](../ai-data/apps/data-access/src/connectors/connector-result.ts)。
- **影响**：调用方通过共享 Schema 后仍可能拿到不一致的结果。
- **验收**：SSE 拒绝额外字段；查询结果校验列、行、数量和受支持值类型的一致性；公共与 DAS 内部验证保持一致。

### R-11 metadata 包测试命令因没有测试文件失败

- [ ] 完成测试组织与必要行为验证。
- **要求**：包声明的测试命令可执行，元数据库基础能力有对应验证。
- **现状与证据**：`packages/metadata` 声明了 Vitest test 脚本，但没有测试文件；执行递归测试时以 `No test files found` 失败。应用侧迁移测试主要检查文件加载和模拟执行器调用。
- **位置**：[metadata/package.json](../ai-data/packages/metadata/package.json)，第 13 行；[sqlserver-database.ts](../ai-data/packages/metadata/src/sqlserver/sqlserver-database.ts)；[迁移测试](../ai-data/apps/data-access/tests/metadata/metadata-migrations.test.ts)。
- **影响**：工作区测试会中断，连接、参数绑定、失败释放和真实迁移执行缺少充分验收依据。
- **验收**：明确包级测试归属，使测试命令正常执行；验证参数绑定、连接失败清理、健康检查和迁移失败行为；真实 SQL Server 的首建与重复启动行为有集成验证记录。

### R-12 元数据库密码的配置约定不一致

- [ ] 确认约定并同步实现、文档和测试。
- **要求与现状**：[data-access-design.md](./data-access-design.md) 第 3 节要求敏感连接值使用密钥系统或引用；`das-config.ts` 明确允许启动配置保存元数据库密码明文，并将 password 定义为必填字段。
- **位置**：[das-config.ts](../ai-data/apps/data-access/src/config/das-config.ts)，第 46 行。
- **影响**：部署与验收人员无法依据同一约定配置服务。
- **验收**：先确定最终启动凭据来源及保护方式，再统一 Schema、加载流程、示例配置和设计说明。本条不记录实际配置值。

### R-13 外连接可选侧行权限仍写入 WHERE

- [ ] 在 API 查询开放前完成正确表达或明确拒绝。
- **要求**：保留主记录的外连接，其可选侧授权限制放入对象预过滤或相应 ON 条件。
- **现状与证据**：API 将注入的行策略统一放入 `query.filters`。使用 LEFT JOIN 和右侧科室权限，已复现输出查询级过滤 `d.dept = A`；DAS 将其编译到 WHERE。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 173 至 212 行。
- **影响**：未匹配可选记录的主记录被排除，统计结果与既定外连接语义不符。
- **验收**：覆盖主记录有授权匹配、仅有未授权匹配、完全无匹配三类情形；主对象权限独立生效。合同暂不支持时返回能力限制。

### R-14 行策略求值、操作符与多角色合并不完整

- [ ] 完成有效权限范围计算与验收。
- **要求**：支持已发布的操作符与 `value_from` 求值；同对象多个允许范围按既定 OR 规则合并，每个对象及其别名独立受限。
- **现状与证据**：仅处理存在固定 value 的 `eq/in` 策略，其他操作和上下文引用被过滤掉；多条策略统一以 AND 注入。已复现 `neq` 策略消失，以及科室 A、B 两个允许范围生成 `dept = A AND dept = B`。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 173 至 212 行；[permission-policy.ts](../ai-data/packages/contracts/src/permission/permission-policy.ts)。
- **影响**：可能漏掉访问限制，也可能把有效允许范围错误收窄为空。
- **验收**：覆盖全部已声明操作符、上下文引用、多个角色、无行限制角色及同对象多别名；无法求值的限制明确拒绝，不能静默丢弃。

### R-15 参数化查询的行列权限和脱敏未落实

- [ ] 完成参数化查询授权与验收。
- **要求**：有行限制时强制绑定可靠权限参数；无法表达则拒绝。固定输出须满足列权限，受限列按规则脱敏。
- **现状与证据**：参数化分支只检查基础参数，没有消费行策略、验证完整固定输出或构建脱敏规则。使用有科室行限制且没有权限参数绑定的模拟数据集，已复现请求仍被签发，parameters 和 output_masks 均为空。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 57 至 63 行、第 216 至 243 行。
- **影响**：参数化数据集可能绕过当前用户的行范围或固定输出限制。
- **验收**：覆盖参数绑定缺失、范围冲突、输入越界、固定返回列禁止访问、需脱敏列及普通默认参数；DAS 收到的是完整授权后的参数与输出规则。

### R-16 组合关联只校验提交条件的子集

- [ ] 完成批准关联的完整匹配与验收。
- **要求**：一条批准关系的全部 column_pairs 共同组成关联条件，同对象对的多条候选关系各自保持完整。
- **现状与证据**：当前逻辑查找目标对象的第一条关系，并检查提交的每个条件是否在其中，没有要求提交全部字段对。配置 `id + org` 组合键、仅提交 id 条件，已复现通过授权。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 153 至 170 行。
- **影响**：关联可能扩大匹配范围、重复统计或连接到错误记录。
- **验收**：缺少任一必需字段对、混合不同候选关系或提交额外条件时明确拒绝；完整选择任一批准关系可通过；多 Join 的实际左右对象和别名正确匹配。

## 4. 已执行验证与范围

以下记录来自本次审查，不代表后续代码状态：

| 检查                              | 结果                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| contracts 单元测试                | 10 个文件、37 项通过                                                                                |
| DAS 全量单元测试                  | 23 个文件、69 项；68 项通过，健康路由 1 项超过默认 5 秒超时                                         |
| 健康路由单独重跑                  | 2 项通过                                                                                            |
| contracts、metadata、DAS 类型检查 | 通过                                                                                                |
| contracts、metadata、DAS ESLint   | 通过                                                                                                |
| 包级递归测试                      | metadata 因无测试文件失败                                                                           |
| 最小复现                          | 脱敏、认证路由入口、有效期、截断、HTTP 类型与空值、公共 Schema、目录和 API 授权问题已按上文记录验证 |

最小复现使用合成数据、临时测试密钥、模拟服务或驱动，没有连接真实业务数据库，也没有修改业务代码。真实数据库兼容性、服务部署和完整用户链路仍需集成验收。

## 5. 建议处理顺序

1. R-01、R-02、R-03：修复敏感数据处理和服务认证边界。
2. R-04 至 R-08：完成审计、结果正确性、目录和资源限制。
3. R-09、R-10、R-13 至 R-16：结合 API 开发补齐共享合同和授权查询场景；尚未满足的场景应先被明确拒绝。
4. R-11：同步补齐元数据库测试；R-12：确认部署约定后统一实现和文档。

每项记录关闭时，补充处理日期、变更文件及验证结果；代码位置变化后同步修正文档链接。
