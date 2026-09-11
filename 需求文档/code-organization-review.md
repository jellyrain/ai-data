# 代码写法与文件组织审查

审查日期：2026-09-11  
状态：待逐项讨论  
代码范围：[ai-data](../ai-data/) 下的应用、共享包、测试与静态检查配置  
关联文档：[功能实现审查](./implementation-review.md) · [开发规范](./development-standards.md)

本文记录代码组织、表达方式和工程检查方面的观察，供逐项讨论处理。S-01 至 S-05 是稳定跟踪编号；所有建议均处于待讨论状态，不代表已经批准或实施的重构。勾选框仅在方案确认、变更完成并满足验收条件后勾选。

## 总体评价

当前代码已经具备可继续演进的基本结构：应用与共享包分开，服务、仓储、连接器的职责大体清楚，依赖可以通过构造参数注入，TypeScript 严格检查已开启。文件长度总体可控。主要改进空间在于让领域归属更准确、依赖能力更明确、注释提供更多业务信息，并让测试与自动检查覆盖真实行为。

API 仍处于开发阶段。本次结构审查不构成模块功能验收；功能缺陷、权限语义和实现缺口统一在[功能实现审查](./implementation-review.md)中跟踪。

## 建议保留的合理结构

| 现有结构                                         | 保留理由与依据                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps` 与 `packages` 分离，API 与 DAS 可独立运行 | 应用运行边界清楚，适合分别开发和部署。启动、构建入口见 [API package.json](../ai-data/apps/api/package.json) 与 [DAS package.json](../ai-data/apps/data-access/package.json)。                                                                                                                                                    |
| `service`、`repository`、`connector` 按职责分工  | 业务协调、持久化和外部数据访问各有落点。后续拆分应沿用这条职责边界，见 [ConversationService](../ai-data/apps/api/src/conversations/conversation-service.ts)、[SqlAuthRepository](../ai-data/apps/api/src/auth/sql-auth-repository.ts) 与 [DatabaseConnector](../ai-data/apps/data-access/src/connectors/database-connector.ts)。 |
| 使用构造注入组织依赖                             | 仓储与驱动可以替换，便于隔离测试；见 [ConversationService](../ai-data/apps/api/src/conversations/conversation-service.ts) 第 29 行附近及 [数据库连接器测试](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts)。                                                                                           |
| TypeScript `strict` 已开启                       | 保留编译期约束，并逐步减少依赖断言绕过的能力检查；见 [tsconfig.base.json](../ai-data/tsconfig.base.json) 第 6 行。                                                                                                                                                                                                               |
| 测试按业务分类镜像 `src`                         | 实现与测试便于相互定位；例如 [连接器实现目录](../ai-data/apps/data-access/src/connectors/) 与 [对应测试目录](../ai-data/apps/data-access/tests/connectors/)。                                                                                                                                                                    |

## 待讨论建议

### S-01：按领域收拢类型与仓储职责

- [ ] 待讨论、处理与验收

**事实**

[auth-types.ts](../ai-data/apps/api/src/auth/auth-types.ts) 同时定义 `ConversationRepository`（第 125 行）、`Conversation`（第 152 行）、`ConversationMessage`（第 169 行）和 `AnalysisRun`（第 187 行）。[SqlAuthRepository](../ai-data/apps/api/src/auth/sql-auth-repository.ts) 第 50 行同时实现 `UserAdminRepository` 与 `ConversationRepository`；[conversation-service.ts](../ai-data/apps/api/src/conversations/conversation-service.ts) 第 1—7 行从 `auth` 导入会话、消息和运行类型。

**影响**

认证模块承担了会话和运行领域的定义与存储职责。修改消息结构、运行状态或会话持久化时，需要进入认证目录，领域变化的影响范围和依赖方向不够直观。

**建议**

认证、身份与会话令牌相关能力继续归 `auth`；对话会话、消息及其仓储接口和实现归 `conversations`。分析运行模块实际实现时，将运行状态、运行持久化等能力归 `analysis-runs`。共享数据库执行器可以继续复用，跨职责事务应在明确的协调位置组织。

拆分以“是否承担独立变化的职责”为依据，结合真实调用关系确定边界，不设置机械的文件行数阈值。

**验收条件**

会话领域类型及持久化实现能够从 `conversations` 定位；认证仓储职责清楚；运行模块实施后的归属与依赖方向明确且无循环依赖。相关导入和依赖装配同步更新，已有认证与会话行为检查通过。

### S-02：统一公共类型出口，按职责整理元数据定义

- [ ] 待讨论、处理与验收

**事实**

共享合同已经采用 Schema 与 `*-types.ts` 分离的规则，但 [contracts/src/index.ts](../ai-data/packages/contracts/src/index.ts) 第 99—100 行直接定义 `ColumnOperation` 和 `MaskingRule`。现行[开发规范](./development-standards.md)第 74—110 行规定了类型文件、Schema 文件及唯一公共出口。

[metadata-records.ts](../ai-data/apps/data-access/src/metadata/metadata-records.ts) 共 356 行，集中容纳数据源配置、加密密钥、暴露对象白名单、HTTP 数据集映射和查询审计定义，相关类型分别在第 90、143、174、247、321 行附近。

**影响**

公共入口兼任类型定义文件，使定位方式与其余合同分类不同。多类元数据定义集中在一个文件，后续各自扩展时容易增加查找成本和无关修改冲突。

**建议**

让公共 `index.ts` 承担导出职责，将公共类型放入所属分类的类型文件，并继续从 Schema 推导。保留 `@ai-data/contracts` 的唯一包入口，应用继续通过该入口引用共享合同。

元数据定义可按数据源、密钥、对象暴露、HTTP 映射、审计等职责适度拆分；具体粒度以变化频率和使用范围决定。只在单个实现中使用的小型专用类型就近定义，共享或具有领域含义的类型放在可明确定位的位置。

**验收条件**

公共入口不再直接声明领域类型；Schema 与公共类型可以按所属分类找到，应用导入路径保持统一。元数据分类边界与使用方对应清楚，类型推导和运行时校验保持一致，类型检查通过。

### S-03：让注释集中解释业务含义与约束原因

- [ ] 待讨论、处理与验收

**事实**

[开发规范](./development-standards.md)第 124—149 行要求对 `.string()`、`.number()`、`.array()` 等基础类型操作补充说明，示例中包含“分析运行 ID 必须是字符串”；第 160 行又要求简单语法行为不重复写无信息注释。第 214 行要求每个 `it(...)` 前添加中文 BDD/TDD 注释。

**影响**

这些要求容易把注释完整度等同于语法覆盖度。逐句解释基础语法或重复测试标题，会增加阅读和同步维护成本，使权限边界、默认语义等更需要解释的信息被稀释。

**建议**

讨论修订注释规范：保留中文业务含义、调用边界、约束原因、默认行为、权限规则和非直观逻辑说明。字段选择某种类型有特殊业务原因时说明原因；语法和名称已经表达的信息保持简洁。

测试用例标题应清楚表达场景及预期行为；额外注释用于解释特殊前置条件、业务理由或容易误解的断言。BDD/TDD 的要求应落实到场景、断言和开发过程。规范修订确认前，现行规范仍是实施依据。

**验收条件**

规范中“基础语法注释”与“避免重复语法”的要求形成一致、可执行的规则。选择一个 Schema 和一组测试作为评审样例，能从注释中读到必要业务原因，且测试标题与注释各自提供有效信息。批量修改范围另行确认。

### S-04：明确依赖能力，统一错误表达与映射

- [ ] 待讨论、处理与验收

**事实**

[app.ts](../ai-data/apps/api/src/app.ts) 第 28 行起的 `createApp` 使用一串可选位置参数，并依据参数组合注册路由。[auth-service.ts](../ai-data/apps/api/src/auth/auth-service.ts) 第 207 行起将认证仓储断言为 `Partial<UserAdminRepository>`，再在运行时检查管理方法是否存在。

[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts) 第 171、223 行分别存在 `void right`、`void config`，变量被读取后没有参与后续行为。[catalog-routes.ts](../ai-data/apps/api/src/routes/catalog-routes.ts) 第 164—188 行附近根据异常文字区分错误，并将其余异常归为认证失败；目录参数错误使用 `INVALID_ARGUMENT`，而[公共错误处理](../ai-data/apps/api/src/routes/contract-error.ts)使用 `INVALID_INPUT`。

**影响**

位置参数和运行时能力探测使依赖关系难以从类型声明判断，遗漏依赖可能表现为路由未注册或调用时失败。无行为的变量占位容易让读者误判检查已完成。按异常文字分支会让提示文案与控制流耦合，不统一的映射也会影响客户端处理和排错。

**建议**

将应用装配改为具名依赖对象，为当前启用的模块明确必需依赖；可选模块应具有明确启用方式及完整依赖校验。服务直接声明所需的接口能力，用户管理能力可以通过独立依赖或明确的组合接口提供。

梳理无行为占位：属于多余读取的清理，属于尚待实现校验的在对应功能项中落实。定义稳定的业务错误类型和错误码，在 HTTP 边界统一映射状态码、响应格式和请求标识；未知异常按内部错误处理。API 尚在开发中，这些改进应随相关模块实现推进。

**验收条件**

依赖装配可按名称阅读，模块缺少必需能力能够在类型检查或启动装配阶段发现。用户管理能力无需通过强制断言后再逐项探测获得。相关路径没有无行为占位；相同业务错误在不同路由的映射一致，修改提示文案不改变错误分类，未知异常具有内部错误响应与可追踪日志。

### S-05：提高测试行为可信度，自动检查明确约定

- [ ] 待讨论、处理与验收

**事实**

[database-connector.test.ts](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts) 第 41 行起的用例要求生成 `SELECT TOP 1`，但模拟驱动返回两行，再断言 `truncated: true`。该模拟返回值与这条 SQL 的真实结果数量不一致，不能证明实际数据库查询能够正确识别截断。

[metadata/package.json](../ai-data/packages/metadata/package.json) 声明了 `test` 命令，当前包中没有独立测试文件。[eslint.config.mjs](../ai-data/eslint.config.mjs) 使用 JavaScript、TypeScript 的基础 recommended 配置和 Prettier 兼容配置，尚未专门检查开发规范中的类型导入和包依赖边界等项目约定。

**影响**

测试可能通过，但真实驱动的返回形状或 SQL 执行行为仍存在缺口。仅声明测试命令也不能说明共享基础设施已有行为覆盖。依赖人工检查的明确约定容易在后续新增代码中出现偏差。

**建议**

优先为业务行为和已确认缺陷建立测试，使模拟驱动的数据数量、列元数据和类型形状符合实际驱动合同。截断检测的具体实现问题及修复范围在[功能实现审查](./implementation-review.md)中跟踪；这里关注测试是否能识别错误实现。

为关键数据库路径补充少量集成测试，验证模拟测试难以证明的 SQL 行为和驱动结果。为元数据库包补充其真实职责所需的独立测试，并明确运行前提。将已明确的 `import type`、共享包入口和应用间依赖边界等规则纳入自动检查，依据当前工程能力选择规则或检查脚本。

**验收条件**

至少有能够在缺陷存在时失败、修复后通过的行为测试。数据库相关用例覆盖符合实际执行结果的返回形状，关键集成测试有明确环境和运行入口。元数据库包的测试命令能够执行实际测试；新增静态规则能发现示例违规。涉及的类型检查、静态检查与测试命令均可运行，并记录实际结果。

## 讨论与处理方式

每次选取一个稳定编号，确认目标边界、实施范围和验收方式；有依赖关系的建议可合并安排。确认后的决定和完成证据记录在对应条目下，保留编号便于后续引用。本文未运行测试，验收条件是后续实施时的检查要求。
