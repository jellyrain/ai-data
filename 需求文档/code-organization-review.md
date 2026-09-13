# 代码写法与文件组织审查

审查日期：2026-09-11  
状态：S-01 至 S-05 已完成当前确认范围；S-05 真实 SQL Server 集成待实跑\
代码范围：[ai-data](../ai-data/) 下的应用、共享包、测试与静态检查配置  
关联文档：[功能实现审查](./implementation-review.md) · [开发规范](./development-standards.md)

本文记录代码组织、表达方式和工程检查方面的观察，供逐项讨论处理。S-01 至 S-05 是稳定跟踪编号；各项确认的方案、实施范围和验证结果记录在对应条目下。勾选框仅在方案确认、变更完成并满足验收条件后勾选。

## 总体评价

当前代码已经具备可继续演进的基本结构：应用与共享包分开，服务、仓储、连接器的职责大体清楚，依赖可以通过构造参数注入，TypeScript 严格检查已开启。文件长度总体可控。主要改进空间在于让领域归属更准确、依赖能力更明确、注释提供更多业务信息，并让测试与自动检查覆盖真实行为。

API 仍处于开发阶段。本次结构审查不构成模块功能验收；功能缺陷、权限语义和实现缺口统一在[功能实现审查](./implementation-review.md)中跟踪。

## 建议保留的合理结构

| 现有结构                                         | 保留理由与依据                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps` 与 `packages` 分离，API 与 DAS 可独立运行 | 应用运行边界清楚，适合分别开发和部署。启动、构建入口见 [API package.json](../ai-data/apps/api/package.json) 与 [DAS package.json](../ai-data/apps/data-access/package.json)。                                                                                                                                                    |
| `service`、`repository`、`connector` 按职责分工  | 业务协调、持久化和外部数据访问各有落点。后续拆分应沿用这条职责边界，见 [ConversationService](../ai-data/apps/api/src/conversations/conversation-service.ts)、[SqlAuthRepository](../ai-data/apps/api/src/auth/sql-auth-repository.ts) 与 [DatabaseConnector](../ai-data/apps/data-access/src/connectors/database-connector.ts)。 |
| 使用构造注入组织依赖                             | 仓储与驱动可以替换，便于隔离测试；见 [ConversationService](../ai-data/apps/api/src/conversations/conversation-service.ts) 的构造函数及 [数据库连接器测试](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts)。                                                                                             |
| TypeScript `strict` 已开启                       | 保留编译期约束，并逐步减少依赖断言绕过的能力检查；见 [tsconfig.base.json](../ai-data/tsconfig.base.json) 第 6 行。                                                                                                                                                                                                               |
| 测试按业务分类镜像 `src`                         | 实现与测试便于相互定位；例如 [连接器实现目录](../ai-data/apps/data-access/src/connectors/) 与 [对应测试目录](../ai-data/apps/data-access/tests/connectors/)。                                                                                                                                                                    |

## 审查条目

### S-01：按领域收拢类型与仓储职责

- [x] 已完成当前确认的职责收拢与回归验证

**审查时事实**

[auth-types.ts](../ai-data/apps/api/src/auth/auth-types.ts) 同时定义 `ConversationRepository`（第 125 行）、`Conversation`（第 152 行）、`ConversationMessage`（第 169 行）和 `AnalysisRun`（第 187 行）。[SqlAuthRepository](../ai-data/apps/api/src/auth/sql-auth-repository.ts) 第 50 行同时实现 `UserAdminRepository` 与 `ConversationRepository`；[conversation-service.ts](../ai-data/apps/api/src/conversations/conversation-service.ts) 第 1—7 行从 `auth` 导入会话、消息和运行类型。

**影响**

认证模块承担了会话和运行领域的定义与存储职责。修改消息结构、运行状态或会话持久化时，需要进入认证目录，领域变化的影响范围和依赖方向不够直观。

**建议**

认证、身份与会话令牌相关能力继续归 `auth`；对话会话、消息及其仓储接口和实现归 `conversations`。分析运行模块实际实现时，将运行状态、运行持久化等能力归 `analysis-runs`。共享数据库执行器可以继续复用，跨职责事务应在明确的协调位置组织。

拆分以“是否承担独立变化的职责”为依据，结合真实调用关系确定边界，不设置机械的文件行数阈值。

**验收条件**

会话领域类型及持久化实现能够从 `conversations` 定位；认证仓储职责清楚；运行模块实施后的归属与依赖方向明确且无循环依赖。相关导入和依赖装配同步更新，已有认证与会话行为检查通过。

**已确认方案与实施范围（2026-09-11）**

- `auth` 负责认证、请求身份、登录会话与用户管理；`SqlAuthRepository` 实现 `UserAdminRepository`。
- 会话、消息、当前分析运行、仓储接口及会话服务结果类型统一归入 [conversation-types.ts](../ai-data/apps/api/src/conversations/conversation-types.ts)；对应 SQL 和数据库行映射归入 [SqlConversationRepository](../ai-data/apps/api/src/conversations/sql-conversation-repository.ts)。
- [启动入口](../ai-data/apps/api/src/index.ts) 分别创建认证仓储和会话仓储，两者共享当前 API 的 `MetadataQueryExecutor`；`ConversationService` 使用会话仓储，并从 `auth` 获取可信身份上下文类型。
- `ConversationService.submitUserMessage` 继续作为用户提交问题的业务入口。运行状态转换、澄清、取消和恢复能力在 [API 实施计划第 6 步](./api-implementation-plan.md#第-6-步运行状态sse-与恢复)推进时收拢到 `analysis-runs`；该阶段一并实现消息与运行原子保存、幂等和会话串行控制，并按失败回滚及并发场景验收。

**验证结果（2026-09-11）**

- 修改前后执行 `pnpm --filter @ai-data/api test`，均为 9 个测试文件、22 个测试通过，包含认证与会话行为。
- `pnpm typecheck`、`pnpm lint`、`pnpm run build` 通过；API 与 DAS 均构建成功。
- 使用本地 Prettier 检查本次涉及的 7 个 TypeScript 文件，全部通过。`pnpm format:check` 仍报告 162 个未修改文件的既有格式问题。
- `pnpm test` 在 `packages/metadata` 因没有测试文件而中止，对应 [R-11](./implementation-review.md#r-11-metadata-包测试命令因没有测试文件失败) 与 S-05；API 测试已通过上述独立命令执行。
- 逐段核对迁移前后的 7 个持久化方法、2 个行映射方法及数据库行类型，内容一致。静态相对导入检查确认 API 内没有循环依赖，`auth` 没有反向依赖 `conversations`。

### S-02：统一公共类型出口，按职责整理元数据定义

- [x] 已完成类型归属整理与回归验证

**审查时事实**

共享合同已经采用 Schema 与 `*-types.ts` 分离的规则，但 [contracts/src/index.ts](../ai-data/packages/contracts/src/index.ts) 第 99—100 行直接定义 `ColumnOperation` 和 `MaskingRule`。现行[开发规范](./development-standards.md)第 74—110 行规定了类型文件、Schema 文件及唯一公共出口。

原 `metadata/metadata-records.ts` 共 356 行，集中容纳数据源配置、加密密钥、暴露对象白名单、HTTP 数据集映射和查询审计定义，相关类型分别在第 90、143、174、247、321 行附近。

**影响**

公共入口兼任类型定义文件，使定位方式与其余合同分类不同。多类元数据定义集中在一个文件，后续各自扩展时容易增加查找成本和无关修改冲突。

**建议**

让公共 `index.ts` 承担导出职责，将公共类型放入所属分类的类型文件，并继续从 Schema 推导。保留 `@ai-data/contracts` 的唯一包入口，应用继续通过该入口引用共享合同。

元数据定义可按数据源、密钥、对象暴露、HTTP 映射、审计等职责适度拆分；具体粒度以变化频率和使用范围决定。只在单个实现中使用的小型专用类型就近定义，共享或具有领域含义的类型放在可明确定位的位置。

**验收条件**

公共入口不再直接声明领域类型；Schema 与公共类型可以按所属分类找到，应用导入路径保持统一。元数据分类边界与使用方对应清楚，类型推导和运行时校验保持一致，类型检查通过。

**已确认方案与实施范围（2026-09-11）**

- `ColumnOperation` 定义在 [column-operation-types.ts](../ai-data/packages/contracts/src/permission/column-operation-types.ts)，`MaskingRule` 定义在 [output-mask-types.ts](../ai-data/packages/contracts/src/query/output-mask-types.ts)，均从原 Schema 推导并通过 `@ai-data/contracts` 导出。
- 数据源、密钥、对象暴露和 HTTP 映射的数据库行 Schema 分别收拢到 `metadata` 下的职责文件；运行时类型分别归 `data-sources`、`secrets`、`catalog` 和 `connectors`。查询审计事件及其推导类型归 `query-execution`，具体文件见 [DAS 实施计划第 2 步](./das-implementation-plan.md#第-2-步das-元数据模型和仓储已完成)。
- 仓储继续负责数据库行校验、字段改名、空值处理和 JSON 配置解析；共享解析函数归 `metadata/parse-persisted-json.ts`。
- [开发规范第 6.1 节](./development-standards.md#61-schema-与类型分离)明确：具有运行时 Schema 的数据形态，其类型从相应 Schema 推导；经过明确转换的内部业务对象可以独立声明类型，并由仓储或转换函数的输出类型衔接。

**验证结果（2026-09-11）**

- 修改前 contracts 的 37 个测试、DAS 的 69 个测试通过；修改后执行 `pnpm -r --no-bail test`，contracts 37 个、DAS 69 个、API 22 个测试通过，共 128 个。`packages/metadata` 仍因没有测试文件失败，对应 R-11 与 S-05。
- `pnpm typecheck`、`pnpm lint`、`pnpm run build` 通过，API 与 DAS 均构建成功。
- 本次涉及的 39 个 TypeScript 文件通过 Prettier 检查；`pnpm format:check` 仍报告 139 个未修改文件的既有格式问题。
- 核对原定义的迁移内容、21 个使用方的实现和 contracts 公共导出集合：Schema 校验、仓储转换与公共导出保持一致，使用方更新为职责对应的导入路径。
- 静态导入检查未发现运行时循环或涉及新增文件的循环；运行时类型文件不依赖 `metadata`，应用代码已全部切换到新路径。

### S-03：让注释集中解释业务含义与约束原因

- [x] 已完成规范修订、样例验收，以及 contracts、metadata、DAS 的全量注释整理

**审查时事实**

[开发规范](./development-standards.md)第 124—149 行要求对 `.string()`、`.number()`、`.array()` 等基础类型操作补充说明，示例中包含“分析运行 ID 必须是字符串”；第 160 行又要求简单语法行为不重复写无信息注释。第 214 行要求每个 `it(...)` 前添加中文 BDD/TDD 注释。

**影响**

这些要求容易把注释完整度等同于语法覆盖度。逐句解释基础语法或重复测试标题，会增加阅读和同步维护成本，使权限边界、默认语义等更需要解释的信息被稀释。

**建议**

讨论修订注释规范：保留中文业务含义、调用边界、约束原因、默认行为、权限规则和非直观逻辑说明。字段选择某种类型有特殊业务原因时说明原因；语法和名称已经表达的信息保持简洁。

测试用例标题应清楚表达场景及预期行为；额外注释用于解释特殊前置条件、业务理由或容易误解的断言。BDD/TDD 的要求应落实到场景、断言和开发过程。规范修订确认前，现行规范仍是实施依据。

**验收条件**

规范中“基础语法注释”与“避免重复语法”的要求形成一致、可执行的规则。Schema 和测试样例能说明必要业务原因，测试标题与注释各自提供有效信息。全量整理覆盖 contracts、metadata、DAS 的源码、测试、SQL 迁移和共享检查配置；API 应用暂不纳入本轮修改。

**已确认方案与实施范围（2026-09-11）**

- 中文注释面向熟悉 TypeScript 的开发者，说明业务含义、设计原因、数据来源和生效边界；Zod 中易误读的机制补充必要技术解释。字段与链式校验可以由一段业务说明共同覆盖，复杂校验前集中说明规则。
- [开发规范第 6.3 节与第 7 节](./development-standards.md#63-zod-注释规范)统一 Schema、基础类型、可选与空值语义、技术机制、JSDoc 和注释准确性的要求。
- [开发规范第 9 节](./development-standards.md#9-测试规范)明确先编写 BDD 场景和验收预期，再编写对应 TDD 测试、确认预期失败，随后实现业务代码并回归。测试预期的变更须有需求依据；第 12 节新增功能清单按同一编写顺序检查。
- [query-dsl.ts](../ai-data/packages/contracts/src/query/query-dsl.ts)作为 Schema 样例，说明标识符字符校验的边界、过滤值的可选条件和跨字段校验位置，并汇总操作符对应的取值规则。
- [查询请求合同测试](../ai-data/packages/contracts/tests/query/data-access-request.test.ts)按结构合法、缺少签名、携带未知字段三个场景组织，用组前说明明确结构校验的范围，标题与断言对应各自场景。
- 全量整理已覆盖 contracts、metadata 和 DAS：合并重复的基础语法说明，补齐字段来源、默认值和空值语义，集中说明递归与跨字段校验；完善 SQL 编译、方言、连接器生命周期、主密钥初始化、持久化转换和迁移事务的注释。
- 33 个测试文件逐个核对，补充测试数据、替身职责和断言边界，保留有信息价值的背景说明。共享 ESLint、Prettier 与 Workspace 配置也补充了用途说明；API 应用文件保持本轮开始时的内容。

**规范与样例验证结果（2026-09-11）**

- 调整前 contracts 的 37 个测试通过。先按三个已定义的场景整理测试用例，再调整 Schema 注释；整理后 contracts 的 38 个测试通过，用例数量增加来自拆分原先合并的两个失败场景。
- 核对 `query-dsl.ts` 去除注释与排版后的代码标记，与本轮修改前一致；查询请求测试的原有数据和 4 条断言保持一致。
- `pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm run build` 通过。
- `pnpm -r --no-bail test` 中 contracts 38 个、API 22 个、DAS 69 个测试通过，共 129 个。`packages/metadata` 因没有测试文件失败，对应 R-11 与 S-05。

**全量注释整理验证结果（2026-09-11）**

- 核对 124 个 TypeScript 文件、2 个 SQL 迁移及共享配置，本轮调整了 106 个源码、测试、迁移和配置文件的注释。原有说明已符合规则的文件继续保留。
- 对全部 TypeScript 与 JavaScript 配置比较去除注释和位置信息后的语法树，结果一致，包含类型声明、测试数据、用例名称和可执行断言；2 个 SQL 迁移的非注释标记一致，共享配置值一致。
- 对比本轮开始时的 SHA-256，API 应用的 49 个受版本管理或已有未跟踪文件均未变化。
- `pnpm format:check`、`pnpm typecheck`、`pnpm lint` 和 `pnpm --filter @ai-data/data-access build` 通过。
- `pnpm --filter @ai-data/contracts --filter @ai-data/data-access test` 通过：contracts 38 个、DAS 69 个，共 107 个测试。本轮为注释与排版调整，既有测试用于回归验证；新增行为仍按开发规范先写 BDD 场景与 TDD 测试。

### S-04：明确依赖能力，统一错误表达与映射

- [x] 已完成 API 当前确认范围及 API 全量注释整理

**实施结果**

- [应用装配](../ai-data/apps/api/src/app.ts)使用[具名依赖合同](../ai-data/apps/api/src/app-types.ts)，当前启用模块全部要求提供依赖。类型检查约束完整能力，启动阶段检查缺失项并指出名称；单模块测试直接注册对应路由。
- [认证服务](../ai-data/apps/api/src/auth/auth-service.ts)直接依赖 `UserAdminRepository`，公开方法所需的用户管理能力在构造类型中明确。
- [ApplicationError](../ai-data/apps/api/src/errors/application-error.ts)使用 contracts 错误码表达已分类业务失败，HTTP 状态、请求 ID 和内部错误日志集中到[统一出口](../ai-data/apps/api/src/routes/contract-error.ts)。路由按业务条件抛出错误，提示文案变化不会改变分类。
- DAS 传输、JWT 校验与持久化记录读取在各自边界转换已知异常，并保留 `cause`。未知异常返回 `INTERNAL_ERROR / 500`，公开响应使用通用说明；DAS 的内部身份认证失败按服务故障处理。
- API 的 37 个源码 TypeScript 文件、13 个测试及辅助 TypeScript 文件、2 个 SQL 迁移和 5 个配置文件均已核对。补充配置来源、默认值、缓存范围、查询转换、仓储读写及迁移说明，校正与实际行为不符的授权和原子性描述。

开发中的 `void right`、`void config` 保留，后续校验随查询权限功能项推进。查询注释说明当前别名定位、关联列对匹配、查询级行条件注入和参数默认值处理的实际边界；R-13 至 R-16 继续按[功能实现审查](./implementation-review.md)跟踪。

**BDD 场景与验收**

| 前提与操作                                 | 验收行为                                                |
| ------------------------------------------ | ------------------------------------------------------- |
| 完整装配当前 API 模块                      | 按具名依赖注册所有业务路由                              |
| 必需依赖缺失                               | 类型检查发现遗漏；启动装配明确指出缺失项                |
| 用户管理调用仓储                           | 构造类型明确要求用户管理能力                            |
| 同一业务错误经过不同路由，提示文案变化     | 错误码与 HTTP 状态保持一致，并包含请求 ID               |
| 请求输入、JSON 语法或刷新 Cookie 编码无效  | 返回 INVALID_INPUT / 400                                |
| 认证失败、权限不足、资源不存在             | 分别返回 401、403、404 的合同错误                       |
| 未识别的服务或数据库异常                   | 返回 INTERNAL_ERROR / 500；日志通过请求 ID 关联原始异常 |
| DAS 无健康实例、连接失败、超时             | 按数据源不可用或查询超时表达                            |
| DAS 错误响应、返回合同损坏、持久化配置损坏 | 在适配器分类并保留原因；内部数据错误返回 500            |
| 达到 API 限流阈值                          | 返回 RATE_LIMITED / 429，并保留重试提示                 |

**验证结果**

- 先写 BDD 场景与主路径测试；实现前首轮 51 个测试因目标行为不符失败，22 个通过。补充坏注册快照及解析异常场景后也分别确认红灯，再修改对应实现。
- API 最终 79 个测试通过；装配类型、用户管理仓储能力、真实路由映射、限流、DAS 适配与持久化错误均有验证。
- 全仓 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm run build` 通过。
- `pnpm -r --no-bail test` 中 contracts 38 个、API 79 个、DAS 69 个测试通过，共 186 个；metadata 包尚无独立测试文件，仍使汇总命令退出码为 1，按 S-05 跟踪。
- 20 个仅调整注释的 TypeScript 文件与修改前语法树一致；2 个 SQL 迁移的非注释标记一致，4 个 JSON 配置及排版忽略文件保持原值。相对本轮开始的文件摘要，代码修改集中在 API 应用。

### S-05：提高测试行为可信度，自动检查明确约定

- [x] 完成：测试行为、metadata 包级验证、工程规则与 SQL Server 集成入口（2026-09-12）
- [ ] 真实 SQL Server 集成实跑：等待专用测试环境。

**BDD 场景**

| 前提与操作                                          | 验收预期                                         |
| --------------------------------------------------- | ------------------------------------------------ |
| 关系查询实际结果为 0、N−1、N、N+1 行                | 返回最多 N 行，只有存在额外结果时 truncated=true |
| 达到最大返回上限 5000 行                            | 内部最多探测 5001 行，公开结果仍遵守 5000 行上限 |
| 四种 SQL 方言处理关系查询                           | 测试驱动遵守 SQL 的 TOP、LIMIT 或 FETCH 限制     |
| 固定存储过程返回少于、等于或超过上限的完整结果集    | 按实际结果裁剪并判断截断，调用参数保持原值       |
| 元数据库绑定字符串、整数、布尔、二进制、日期及 null | 按声明的数据库类型绑定并保持 SQL 与值分离        |
| 元数据库连接失败，或失败清理再次报错                | 释放连接池，保留连接失败及清理失败的原因         |
| 元数据库健康探针、无记录集写入与执行失败            | 正确报告健康状态、空列表及原始失败               |
| 迁移目录包含乱序文件、无关文件或执行失败            | 只加载 SQL 文件并依次执行，失败后停止后续迁移    |
| 类型导入、共享包公开入口、跨应用引用出现违规        | 工程检查报告对应规则，合法样例通过               |
| 使用专用 SQL Server 测试配置运行集成入口            | 验证首建、重复迁移、失败回滚和真实 SQL 截断行为  |

先编写上述场景的测试。缺陷与新增规则的目标用例确认红灯后再改实现；现有正确行为的补测以验证现状为准。真实 SQL Server 暂无专用环境，本轮完成独立运行入口，集成实跑状态单独记录。

**实施结果**

- [连接器测试](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts)中的驱动替身按实际 SQL 上限返回记录，覆盖四种方言的 0、N−1、N、N+1 行及最大 5000 行边界。关系查询编译为 N+1 行探测，出口保留 N 行；固定存储过程保留原调用参数，按完整返回结果集裁剪。同步修复 [R-05](./implementation-review.md#r-05-数据库结果截断状态不准确)。
- [metadata 包测试](../ai-data/packages/metadata/tests/sqlserver/)新增连接池配置、六类绑定及 null、连接失败释放、健康检查、结果转换、迁移排序与失败停止等 22 个用例。连接与清理同时失败时，以 AggregateError 保留两个原因；[R-11](./implementation-review.md#r-11-metadata-包测试命令因没有测试文件失败)的包测试中断问题已解决。
- [ESLint 配置](../ai-data/eslint.config.mjs)启用类型导入检查，[工作区规则](../ai-data/scripts/eslint/import-boundaries.mjs)按各包的公开 exports 检查跨包引用，并拦截跨应用源码依赖及共享包对应用的反向依赖。规则覆盖静态导入、重导出、字面量动态导入和类型引用；同包源码与测试之间的相对路径合法。现有代码同步修正 3 处类型导入。
- [工程规则测试](../ai-data/scripts/tests/eslint-rules.test.mjs)直接加载工作区实际 ESLint 配置，验证合法与违规样例，包含包目录执行和绝对路径场景。根 `pnpm test` 先运行规则测试，再执行所有包测试；`pnpm lint` 同时检查根配置和工程脚本。
- [SQL Server 集成入口](../ai-data/apps/data-access/tests/integration/sqlserver.integration.ts)包含 11 个用例，使用实际 API、DAS 迁移和 DAS SQL Server 驱动，验证首建、重复迁移的数据保留、提交前失败回滚及真实查询截断。入口分别创建应用测试库，并清理本轮资源；配置和命令见 [测试运行说明](../ai-data/TESTING.md)。
- [开发规范](./development-standards.md)补充自动检查的导入规则、驱动替身约束及默认测试与数据库集成测试的运行约定。

**验证记录**

- 先写 BDD 场景和目标测试。实现前，遵守 SQL 上限的连接器测试有 8 个预期失败，编译器有 3 个预期失败，metadata 有 1 个清理错误覆盖原因的预期失败，工程规则有 9 个违规漏报失败；随后修改实现使对应测试通过。
- `pnpm test` 通过：工程规则 15 个；contracts 38 个、metadata 22 个、API 79 个、DAS 92 个，共 246 个测试。递归测试正常结束。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 均通过，API 与 DAS 构建产物生成成功。
- 真实 SQL Server 暂无专用环境，本轮按确认范围完成入口。已运行缺配置的入口验证：命令成功加载集成文件后给出 `SQLSERVER_TEST_CONFIG` 配置提示并以状态 1 退出，11 个数据库用例未执行。数据库首建、回滚与真实驱动行为仍待专用环境实跑。

## 讨论与处理方式

每次选取一个稳定编号，确认目标边界、实施范围和验收方式；有依赖关系的建议可合并安排。确认后的决定和完成证据记录在对应条目下，保留编号便于后续引用。初次审查未运行测试；后续实施的验证结果记录在对应条目下。
