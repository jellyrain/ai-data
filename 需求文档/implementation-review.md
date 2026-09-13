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

P1 表示优先处理的权限、敏感数据或关键查询正确性问题；P2 表示功能完整性、结果合同和可靠性问题。“待确认”表示文档与代码约定需要先统一。各条目按实际验收更新状态；每次处理应记录修改内容、验证结果和剩余限制。

| 编号 | 优先级 | 范围                  | 问题                                 | 状态                   |
| ---- | ------ | --------------------- | ------------------------------------ | ---------------------- |
| R-01 | P1     | DAS                   | 部分脱敏在末尾保留 0 位时泄露原文    | 已修复并验收           |
| R-02 | P1     | DAS / API             | 内部管理、目录和心跳通道认证不足     | 已修复并验收           |
| R-03 | P1     | DAS / API             | 授权有效期和 JWT 必需字段校验不完整  | 已修复并验收           |
| R-04 | P2     | DAS                   | 审计仓储未接入请求执行链             | 已接通；集成待实跑     |
| R-05 | P2     | DAS                   | 数据库结果截断状态不准确             | 已修复；集成待实跑     |
| R-06 | P2     | DAS                   | 结果类型与可空性未完整标准化         | 已修复；集成待实跑     |
| R-07 | P2     | DAS                   | 存储过程目录与 HTTP 输入参数定义不足 | 已实现受控调用；集成待实跑 |
| R-08 | P2     | DAS                   | 超时、取消、排队与成本限制未完整落地 | 资源控制已实现；集成待实跑 |
| R-09 | P2     | contracts / API / DAS | v0.2 新增合同与执行能力待补齐        | 对象过滤与分层聚合已实现；业务合同按阶段推进 |
| R-10 | P2     | contracts             | SSE 严格校验和查询结果一致性校验不足 | 已修复并验收           |
| R-11 | P2     | metadata              | 包测试命令因没有测试文件失败         | 包测试完成；集成待实跑 |
| R-12 | 待确认 | DAS / 文档            | 元数据库密码的配置约定不一致         | 待讨论                 |
| R-13 | P1     | API                   | 外连接可选侧行权限仍写入 WHERE       | 已修复并验收           |
| R-14 | P1     | API                   | 行策略求值、操作符与多角色合并不完整 | 已修复并验收           |
| R-15 | P1     | API                   | 参数化查询的行列权限和脱敏未落实     | 已修复并自动化验收     |
| R-16 | P1     | API                   | 组合关联只校验提交条件的子集         | 已修复并验收           |

## 3. 问题详情

### R-01 部分脱敏在末尾保留 0 位时泄露原文

- [x] 完成修复与验收（2026-09-13）。
- **要求**：按已签名的 `output_masks` 对字符串结果执行部分脱敏。
- **审查时证据**：`suffix_length: 0` 通过合同校验，执行时 `slice(-0)` 返回完整字符串。使用合成手机号 `13800138000`、前缀 3 位、后缀 0 位，实际得到 `138********13800138000`，预期为 `138********`。已执行内存最小复现。
- **位置**：[result-masker.ts](../ai-data/apps/data-access/src/query-execution/result-masker.ts)，第 38 行；[output-mask.ts](../ai-data/packages/contracts/src/query/output-mask.ts)。
- **影响**：合法脱敏配置会将敏感原文包含在返回值中。
- **验收**：覆盖后缀 0 位、前后缀均 0 位、短字符串、空字符串和 null；返回值仅包含配置允许保留的字符。

**处理记录（2026-09-13）**：后缀长度为 0 时取空字符串；短值继续采用整串遮罩。[脱敏测试](../ai-data/apps/data-access/tests/query-execution/result-masker.test.ts)覆盖两端为 0、只保留后缀、短于或等于保留长度、空字符串、null 及原有按别名处理场景，共 9 项通过。修改前两个新增边界用例失败；[查询路由测试](../ai-data/apps/data-access/tests/routes/query-route.test.ts)同时验证有效签名请求经过真实规划和脱敏后返回 `138********`。

### R-02 内部管理、目录和心跳通道认证不足

- [x] 完成调用方认证与自动化验收（2026-09-13）。
- **要求**：DAS 目录和管理接口验证 API 签名，用户权限由 API 控制；DAS 首次注册验证实例接入凭证，后续心跳校验随机会话，失效后重新注册。
- **审查时证据**：查询路由有验签；管理和目录路由直接进入业务处理，应用未注册覆盖这些路由的统一认证。使用模拟管理服务发起无 Authorization 的请求，处理函数被调用并返回 200。DAS 心跳发送和 API 接收链也未包含服务身份验证。
- **位置**：[管理路由](../ai-data/apps/data-access/src/routes/data-source-management-route.ts)，第 29 行；[目录路由](../ai-data/apps/data-access/src/routes/catalog-route.ts)；[DAS 启动与心跳](../ai-data/apps/data-access/src/index.ts)；[API 心跳接收](../ai-data/apps/api/src/routes/data-access-routes.ts)。
- **影响**：能够访问端口的调用方可以进入配置操作或目录读取；未认证心跳可影响服务登记。实际暴露范围取决于部署网络配置。
- **验收**：缺失、无效、过期及错误受众的服务凭证在业务处理前被拒绝；有效凭证可完成对应操作；心跳身份与获准实例绑定。管理用户授权仍由 API 负责。

**处理记录（2026-09-13）**：

- API 按 `trusted_data_access_services` 管理获准实例、启用状态与 `credential_version`，系统管理员领取 API 签发的接入凭证并部署到 DAS 文件。首次 `/internal/data-access/register` 验签后返回 32 字节随机会话；API 保存摘要并绑定实例与地址。每 30 秒心跳仅校验会话，成功后续期 90 秒。会话过期、重新注册或 API 重启后旧会话失效，DAS 收到 HTTP 401 后读取当前凭证文件重新注册。查询和目录调度同时要求健康记录与有效会话，历史健康记录不能跳过注册。
- API 目录 Client 与五类管理代理签发 60 秒 JWT，绑定目标实例、请求用途、方法、路径及正文摘要。DAS 六个入口在业务调用前统一验证。API 的实例诊断、目录诊断及管理代理要求 `system_admin` 或 `data-access:manage`；接入凭证领取仅限系统管理员。HTTP 客户端禁止重定向，传输异常在进入日志前移除请求配置和底层对象。
- 修改前 6 项 DAS 入口与 3 项 API 入口认证测试失败；新增测试验证有效及无效入口凭据、错误用途和受众、过期及正文篡改、首次注册、会话续期与替换、地址绑定、实例停用、凭证版本变更、API 重启、DAS 自动恢复及日志凭据保护。测试分别位于 [DAS 路由认证](../ai-data/apps/data-access/tests/routes/internal-auth.test.ts)、[DAS 服务验签](../ai-data/apps/data-access/tests/auth/internal-service-verifier.test.ts)、[API 入口认证](../ai-data/apps/api/tests/routes/data-access-auth.test.ts)、[API 会话服务](../ai-data/apps/api/tests/data-access/data-access-session-service.test.ts)和 [DAS 心跳客户端](../ai-data/apps/data-access/tests/api/data-access-heartbeat-client.test.ts)。
- 根级 `format:check`、`typecheck`、`lint`、`test`、`build` 全部通过；测试共 392 项（工程 15、contracts 44、metadata 22、API 118、DAS 193）。使用临时测试密钥、内存仓储及 HTTP 注入，真实数据库部署链路尚未实跑。
- 接入凭证生命周期由 API 配置控制，配置变更需重启 API；会话当前保存在单个 API 进程内存中。部署、加密链路、文件权限、停用与轮换要求见 [服务接入说明](../ai-data/SERVICE-AUTH.md)。

### R-03 授权有效期和 JWT 必需字段校验不完整

- [x] 完成短时授权验证与验收（2026-09-13）。
- **要求**：验证 JWT 的签名、签发方、受众和规定 claims，并拒绝过期的访问上下文。
- **审查时证据**：验签器未检查 `access.expires_at`，也未强制要求 `exp`、`iat`、`nbf`、`jti` 存在。使用临时测试密钥，已复现“有效 JWT + 已过期 access”通过验证，以及缺少这些字段的已签名 JWT 通过验证。测试未使用项目真实私钥。
- **位置**：[internal-query-verifier.ts](../ai-data/apps/data-access/src/auth/internal-query-verifier.ts)，第 31 行；[API JWT 签发](../ai-data/apps/api/src/auth/jwt-service.ts)；[API 授权截止时间](../ai-data/apps/api/src/query/query-authorization-service.ts)。
- **影响**：请求签名正确时，访问上下文的短时授权窗口仍可能未被执行。
- **验收**：覆盖过期 access、缺失必需 claims、未到生效时间、过期 JWT、错误签发方/受众及篡改请求；验证失败时不进入连接器执行。

**处理记录（2026-09-13）**：DAS 要求完整时间、令牌标识和查询身份 claims，检查 60 秒签发窗口，并将用户、组织、运行、策略版本和令牌用途与请求绑定。`access.expires_at` 按东八区解析，到达截止时刻即拒绝。API 使用同一秒设置 `iat`、`nbf` 与 60 秒后的 `exp`，将授权截止时间显式按东八区签发为 55 秒后。

- [验签器测试](../ai-data/apps/data-access/tests/auth/internal-query-verifier.test.ts)33 项，覆盖有效授权、截止边界、必需 claims、未来签发、令牌生效与过期、签发方/受众、身份不一致、错误密钥和请求篡改；修改前 21 项失败，修改后全部通过。
- [查询路由测试](../ai-data/apps/data-access/tests/routes/query-route.test.ts)7 项，以真实验签器、规划器和执行服务验证成功路径及认证拒绝时连接器未被获取或执行。
- [API JWT 测试](../ai-data/apps/api/tests/auth/jwt-service.test.ts)验证签发必需字段；[授权时间测试](../ai-data/apps/api/tests/query/query-authorization-service.test.ts)验证东八区截止时间。在 UTC 环境已复现修复前缺少 `nbf` 和截止时间偏差 8 小时的问题。
- 本轮共新增 50 项测试；根 `pnpm test` 296 项通过（工程规则 15、contracts 38、metadata 22、API 81、DAS 140）。本条覆盖查询入口的授权验证；`jti` 重放防护继续按部署安全设计验收。
- UTC 环境下 53 项目标测试通过；根 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 均通过。
- 发布时先更新 API 签发端，再更新 DAS 验证端；旧版 API 签发的令牌缺少 `nbf`，会被新版 DAS 拒绝。

### R-04 审计仓储未接入请求执行链

- [x] 接入审计并自动化验收各结果路径（2026-09-13）。
- [ ] SQL Server 实际审计写入与部署链路待专用环境验收。
- **要求**：成功、拒绝、超时和失败写入 `query_audit_logs`，保留可关联的用户、组织、运行和策略信息。
- **现状与证据**：`AuditRepository` 和数据库表已实现。查询服务只执行映射、连接器调用和脱敏，启动组装未注入审计仓储；源码检索未发现请求链对该仓储的调用。
- **位置**：[query-execution-service.ts](../ai-data/apps/data-access/src/query-execution/query-execution-service.ts)，第 19 行；[audit-repository.ts](../ai-data/apps/data-access/src/metadata/audit-repository.ts)。
- **影响**：仓储测试通过不能证明实际查询已被审计。
- **验收**：四类处理结果均产生可关联记录；早期认证拒绝只记录可信信息；日志与审计不包含不必要的敏感明文；审计写入失败的处理约定明确且有验证。

**处理记录（2026-09-13）**：[AuditedQueryService](../ai-data/apps/data-access/src/query-execution/audited-query-service.ts)接入查询入口，启动时注入真实 `AuditRepository`。执行成功、授权或规划拒绝、超时和失败均写入审计；取消按 `failed` 记录 `CANCELLED`。服务端为请求生成唯一关联 ID，并通过 `x-request-id` 响应头及错误 `request_id` 返回。

身份仅在验签成功后进入审计；无效签名和 JSON 格式错误使用匿名拒绝记录。摘要只记录查询结构、对象与参数名，不保存参数值、凭证、签名或结果行。审计写入失败时返回服务不可用错误，成功结果也不能越过该检查。[审计服务测试](../ai-data/apps/data-access/tests/query-execution/audited-query-service.test.ts)和[查询路由测试](../ai-data/apps/data-access/tests/routes/query-route.test.ts)覆盖各结果路径、可信身份、摘要、审计故障与真实本地 HTTP 断开；新增行为均先复现失败再通过。

### R-05 数据库结果截断状态不准确

- [x] 完成截断状态修复与行为回归。
- [ ] 真实 SQL Server 集成用例待专用环境实跑。
- **要求**：`truncated` 准确说明是否因返回限制丢弃了可返回的结果行。
- **现状与证据**：SQL 先使用 `TOP N` / `LIMIT N` 等限制，执行后再判断驱动结果是否多于 N 行。用遵守 `TOP 2` 的模拟驱动和 3 行合成源数据复现：返回 2 行，`truncated` 仍为 false。已有测试让 `TOP 1` 返回 2 行，未模拟真实限制行为。
- **位置**：[sql-query-compiler.ts](../ai-data/apps/data-access/src/connectors/sql-query-compiler.ts)，第 39 行；[database-connector.ts](../ai-data/apps/data-access/src/connectors/database-connector.ts)，第 109 行；[连接器测试](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts)。
- **影响**：后续模型、图表或统计可能把受限结果视为完整结果。
- **验收**：覆盖结果数少于、等于和大于限制的情形；返回数量仍遵守上限。关系查询与固定参数化结果各自有准确的截断判断方案和测试。

**S-05 处理记录（2026-09-12）**：关系查询按 N+1 行编译以探测截断，出口最多返回 N 行；固定存储过程保留调用参数并按实际返回结果集裁剪。四种方言的替身遵守生成 SQL 限制，覆盖空、少于、等于、超过上限和 5000 行最大边界。修改前连接器 8 个、编译器 3 个目标测试失败，修改后相关 32 个测试通过。真实 SQL Server 查询与存储过程用例已加入 [集成入口](../ai-data/apps/data-access/tests/integration/sqlserver.integration.ts)，尚未实跑。

### R-06 结果类型与可空性未完整标准化

- [x] 完成驱动元数据、值转换和可空性自动化验收（2026-09-13）。
- [ ] 四类真实数据库的类型兼容性待专用环境实跑。
- **要求**：结果按统一列类型和 JSON 表达返回，HTTP 字段遵守配置的类型及 nullable。
- **修复前证据**：MySQL、PostgreSQL、Oracle 驱动仅保留列名，未传递实际类型，连接器将缺少类型的列默认为 string。HTTP 字段映射直接返回原值，仅检查 undefined，未拒绝不可空字段的 null。使用模拟 HTTP 响应已复现 integer 列返回字符串 `"12"`、不可空字段返回 null。
- **位置**：[database-drivers.ts](../ai-data/apps/data-access/src/connectors/database-drivers.ts)，第 98、129、167 行；[http-api-connector.ts](../ai-data/apps/data-access/src/connectors/http-api-connector.ts)，第 157 行。
- **影响**：列描述与真实值不一致，影响后续类型校验、图表、计算和脱敏处理。
- **验收**：按各驱动实际类型信息映射；覆盖数值、布尔、日期时间、二进制、null 与空结果；HTTP 转换失败和非空约束违反时返回明确错误。

**处理记录（2026-09-13）**：四种驱动保留实际列元数据；[统一值转换](../ai-data/apps/data-access/src/connectors/result-value.ts)处理数值、布尔、日期时间和二进制，数据库与 HTTP 出口共用。HTTP 同时拒绝不可空字段的缺失值与 null。SQL Server 使用实际类型工厂，MySQL 使用类型码、字符集和位宽，PostgreSQL 使用 OID，Oracle 使用原生类型名与数值小数位；空结果仍保留列定义。SQL Server rowversion 映射为 buffer、Oracle DATE 为 datetime、PostgreSQL bit 为 string，MySQL BIT(1) 为 boolean、多位 BIT 为 buffer，目录与结果类型保持一致。

- 日期时间区分无时区墙钟值和带时区时刻，后者转为东八区。PostgreSQL 无时区日期按文本读取；MySQL 每次借出连接后先设置东八区会话，再在同一连接执行查询，设置失败时停止查询，所有路径归还连接。
- 文本数值无法保持有效数字、integer 超出安全整数范围或 decimal 非有限数值时明确报错。PostgreSQL money 在目录和结果中按 string 保留本地化货币文本，numeric / decimal 继续按数值类型转换。SQL Server 驱动已经解析成 number 的小数不能反推出源数据的舍入，高精度十进制合同仍需单独设计。当前数值与时间表达见 [结果合同](./contracts.md#633-查询结果的标准化与边界校验)。
- [驱动测试](../ai-data/apps/data-access/tests/connectors/database-drivers.test.ts)、[连接器测试](../ai-data/apps/data-access/tests/connectors/database-connector.test.ts)、[转换测试](../ai-data/apps/data-access/tests/connectors/result-value.test.ts)和 [HTTP 测试](../ai-data/apps/data-access/tests/connectors/http-api-connector.test.ts)覆盖类型、空值、空结果、精度和时区边界。MySQL 位宽与会话准备先复现 5 项失败，修复后包含相关结果校验的 6 个目标文件共 91 项通过。真实数据库集成尚未运行。
- 初始驱动元数据 4 项、数据库值转换 5 项先复现失败；复核补充 PostgreSQL money 的目录与地区格式，以及 decimal 可往返的大数，共 8 项先失败后通过。SQL Server Time 另复现源 `02:00:00` 被错误增加八小时，修复为按无时区纯时间返回 `HH:mm:ss`；其他源时间文本保持原值。UTC 环境下值转换和驱动 39 项通过。

### R-07 存储过程目录与 HTTP 输入参数定义不足

- [x] 补齐可信定义、固定输出与自动化调用链验收（2026-09-13）。
- [ ] 各数据库真实过程调用与新迁移待专用环境实跑。
- **要求**：目录提供固定输出列，以及真实输入参数类型、必填状态和默认语义。
- **现状与证据**：数据库目录 SQL 发现存储过程名称，但输出列与输入参数未发现或配置补齐；模拟其实际投影经过目录服务，得到 `columns: []`、`query_parameters: []`。HTTP 参数全部被声明为 string、非必填，映射元数据没有保存完整参数定义。
- **位置**：[SQL Server 目录](../ai-data/apps/data-access/src/connectors/dialects/sqlserver-dialect.ts)，第 33 行；[目录服务](../ai-data/apps/data-access/src/catalog/catalog-service.ts)；[HTTP 参数声明](../ai-data/apps/data-access/src/connectors/http-api-connector.ts)，第 88 行；[映射元数据](../ai-data/apps/data-access/src/metadata/api-dataset-records.ts)。
- **影响**：API 无法可靠完成参数校验、固定结果列授权及模型目录描述。
- **验收**：支持的参数化对象具有可验证的输入与固定输出定义；不能可靠发现的部分有受控配置方式；覆盖必填、默认值、类型错误、空结果和输出变化。各数据库按其真实调用及返回方式集成验证。

**处理记录（2026-09-13）**：管理员通过对象白名单配置 `procedure_definition`，由新迁移 `002_procedure_definitions.sql` 持久化。目录只对定义完整且可执行的调用形态声明 `has_complete_output: true`。HTTP 映射明确保存输入类型、必填与默认值；调用前验证未知、重复、缺失及类型错误，按可信声明顺序补齐过程参数。

API 签名覆盖审核后的 `expected_output`，DAS 将其与本地固定定义比较，连接器再核对实际列集合、类型、可空性及空结果元数据。SQL Server、MySQL 支持一个表格结果；PostgreSQL 使用明确原生类型的 `CALL` 参数与 OUT-only 槽位。Oracle 存储过程的游标及隐式结果调用仍待实现，当前拒绝执行。原有 HTTP 参数映射必须补齐 `dataType`、`required`。定义、升级和验收说明见 [参数化数据集配置](../ai-data/PARAMETERIZED-QUERIES.md)。

### R-08 超时、取消、排队与成本限制未完整落地

- [x] 完成超时、并发、排队、取消及自动化资源释放验收（2026-09-13）。
- [ ] 四类数据库的实际中断及连接回收待专用环境实跑。
- **要求**：查询受数据源的超时、并发和排队约束；取消传播到在途工作。`cost_limit` 保留历史配置兼容性，不作为当前执行限制。
- **现状与证据**：已有并发闸门，但外层等待队列没有显式容量限制。MySQL 仅设置连接超时，Oracle 执行未接入配置的查询超时；查询链没有取消信号。`costLimit` 已保存，但未发现执行限制使用点。以上为静态检查结果。
- **位置**：[database-drivers.ts](../ai-data/apps/data-access/src/connectors/database-drivers.ts)；[database-connector.ts](../ai-data/apps/data-access/src/connectors/database-connector.ts)；[http-api-connector.ts](../ai-data/apps/data-access/src/connectors/http-api-connector.ts)；[query-planner.ts](../ai-data/apps/data-access/src/query-planning/query-planner.ts)。
- **影响**：慢查询和积压请求可能长时间占用连接、内存或运行资源。
- **验收**：用可控慢任务验证执行超时、排队拒绝、等待中取消、执行中取消及连接释放；成本配置有明确可执行语义，尚未支持的限制应在能力说明中准确呈现。

**处理记录（2026-09-13）**：[QueryResourceGate](../ai-data/apps/data-access/src/connectors/query-resource-gate.ts)按数据源管理活动和等待容量，两者各为 `concurrency_limit`。`timeout_ms` 覆盖进入连接器后的排队与执行，队列满立即拒绝；取消或超时及时结束调用方等待，活动名额在底层工作清理后才释放，关闭连接器会取消并排空在途工作。

API 请求断开沿 Axios 到 DAS，再传入数据库或 HTTP 调用。SQL Server 使用请求取消与单次请求超时，MySQL 销毁并移除借出的连接，PostgreSQL 结束活动专用连接，Oracle 使用 `callTimeout`、`breakExecution` 和连接归还。HTTP 中断请求并等待 socket 关闭。新测试覆盖队列与截止竞态、取消传播、池初始化故障清理；API 与 DAS 路由另以真实本地 HTTP 连接验证断开传播。测试使用驱动替身及已安装依赖的实际接口，真实数据库验证仍待执行。

管理输入现在可省略 `cost_limit`；已有字段继续保存但不参与查询放行。返回行数限制与 `truncated` 继续按结果合同执行；完整大批量明细的分页及异步交付按后续查询能力规划。

### R-09 v0.2 新增合同与执行能力待补齐

- [x] 提前完成关系查询的对象过滤合同及 API → DAS 执行链（2026-09-13）。
- [x] 完成每对象预聚合、唯一键、关联基数与统计扩行校验（2026-09-13）。
- [ ] 按对应阶段完成合同与场景验收。
- **要求**：见 [contracts.md](./contracts.md) 第 6.3.1、6.4、6.5 节。
- **现状**：对象预过滤、每对象预聚合加最终聚合、业务唯一键及关联基数已实现。带值 ON、指标统计定义和总计公式，以及运行恢复、指标版本、证据和报告范围等合同仍按业务阶段推进。
- **位置**：[query-dsl.ts](../ai-data/packages/contracts/src/query/query-dsl.ts)；[api-dataset.ts](../ai-data/packages/contracts/src/catalog/api-dataset.ts)；[sse-events.ts](../ai-data/packages/contracts/src/sse/sse-events.ts)。
- **影响**：基础 Schema 完成不等于新增设计场景可执行。此项属于文档已注明的计划内工作。
- **验收**：新增能力同时具备共享合同、API 生成与校验、DAS 执行及边界测试；暂不可正确表达的查询由 API 明确拒绝。指标、运行和报告合同按各自阶段验收，不将其业务规划职责转移给 DAS。

**本次完成范围（2026-09-13）**：`relational_query` 的 `from` 与每个 Join 新增可选 `filters`，只接受自身别名。API 把对象业务条件和授权范围合并，整体签名覆盖这些字段；DAS [规划器](../ai-data/apps/data-access/src/query-planning/query-planner.ts)映射字段后，[编译器](../ai-data/apps/data-access/src/connectors/sql-query-compiler.ts)按四种方言生成带参数的派生表。`query.filters` 保持关联后筛选语义，空 AND 为真、空 OR 为假。参数化查询继续使用受控参数合同。

[合同测试](../ai-data/packages/contracts/tests/query/object-filters.test.ts)、[规划测试](../ai-data/apps/data-access/tests/query-planning/object-filters.test.ts)与[编译执行测试](../ai-data/apps/data-access/tests/connectors/object-filters.test.ts)共 17 项通过；先复现合同 1 项、DAS 8 项失败。LEFT/RIGHT JOIN 的三类匹配情形与同对象多别名链式关联经内存 SQLite 执行验证，四种目标数据库完成 SQL 编译断言。另有 2 项[验签测试](../ai-data/apps/data-access/tests/auth/internal-query-verifier.test.ts)验证合法对象过滤与篡改拒绝。本条其余合同继续保持未完成状态。

**分层聚合处理记录（2026-09-13）**：`from` 和 `joins[]` 新增 `pre_aggregate: { group_by, select }`。每个对象先按自身权限与业务条件过滤，再按完整分组键投影，之后关联并进行最终统计。API 验证每层字段与能力、派生列来源及脱敏，DAS 校验作用域并编译为嵌套 SQL；只有最外层应用 N+1 返回行数探测，排序可引用最终输出别名。

API 业务配置新增 `unique_keys`、批准关系 `relation_id` 与 `cardinality`。保存及执行时检查字段、完整关联键和单一匹配侧的唯一键依据；查询按实际派生分组键与关联链追踪扩行，拒绝可能重复计算的 SUM/COUNT/AVG。统计函数按 DSL 明确的层次执行，指标总体均值、比率和总计口径由业务定义确定。

验证包含多费用与多处方分别汇总后关联、同额费用逐笔累计、复合键去重、无明细 LEFT JOIN、权限在聚合前执行、同对象多别名、派生字段重命名和内层不截断。四种方言进行编译校验，统计结果用内存 SQLite 执行核对，真实数据库验收仍待专用环境。配置与升级说明见 [分层聚合](../ai-data/RELATIONAL-AGGREGATION.md)。

复核补齐派生列沿源字段继承过滤、分组和排序禁令，聚合结果别名排序也接受该检查；过滤值使用当前层的真实类型。SQL Server 两层 `AVG` 均提升到 `FLOAT(53)` 计算，避免整数输入平均值被截断，结果采用当前 JavaScript `number` 合同的双精度近似值。专用 SQL Server 集成入口已补该场景，尚未实跑。

### R-10 SSE 严格校验和查询结果一致性校验不足

- [x] 完成已有合同边界校验与自动化验收（2026-09-13）。
- **要求**：服务边界拒绝未知字段；查询结果行数和单元格与声明相符。
- **修复前证据**：SSE 事件根对象未使用 `.strict()`，额外字段会被接受并剥离。公共 `queryResultSchema` 接受行数与 rows 长度不一致、integer 列携带任意字符串或行内额外嵌套字段。以上均已通过 Schema 最小复现。DAS 内部结果 Schema 已校验行数一致，公共合同仍未同步该约束。
- **位置**：[sse-events.ts](../ai-data/packages/contracts/src/sse/sse-events.ts)，第 5 行；[query-result.ts](../ai-data/packages/contracts/src/query/query-result.ts)，第 15 行；[connector-result.ts](../ai-data/apps/data-access/src/connectors/connector-result.ts)。
- **影响**：调用方通过共享 Schema 后仍可能拿到不一致的结果。
- **验收**：SSE 拒绝额外字段；查询结果校验列、行、数量和受支持值类型的一致性；公共与 DAS 内部验证保持一致。

**处理记录（2026-09-13）**：[queryResultTableSchema](../ai-data/packages/contracts/src/query/query-result.ts)验证唯一列名、精确行字段与各列值类型，公共结果进一步要求行数一致；DAS 内部结果直接使用公共 Schema。SSE 每类事件根对象使用严格校验，`table` 复用同一表格 Schema。先复现结果校验 7 项与 SSE 校验 5 项失败；修改后[结果测试](../ai-data/packages/contracts/tests/query/query-result.test.ts)和 [SSE 测试](../ai-data/packages/contracts/tests/sse/sse-events.test.ts)共 18 项通过，覆盖未知字段、类型不符、缺失或多余字段、重复列名、错误行数及合法 null、空二进制、空结果。

### R-11 metadata 包测试命令因没有测试文件失败

- [x] 完成 metadata 包级测试与必要行为验证。
- [ ] 真实 SQL Server 首建、重复迁移与失败回滚待专用环境实跑。
- **要求**：包声明的测试命令可执行，元数据库基础能力有对应验证。
- **现状与证据**：`packages/metadata` 声明了 Vitest test 脚本，但没有测试文件；执行递归测试时以 `No test files found` 失败。应用侧迁移测试主要检查文件加载和模拟执行器调用。
- **位置**：[metadata/package.json](../ai-data/packages/metadata/package.json)，第 13 行；[sqlserver-database.ts](../ai-data/packages/metadata/src/sqlserver/sqlserver-database.ts)；[迁移测试](../ai-data/apps/data-access/tests/metadata/metadata-migrations.test.ts)。
- **影响**：工作区测试会中断，连接、参数绑定、失败释放和真实迁移执行缺少充分验收依据。
- **验收**：明确包级测试归属，使测试命令正常执行；验证参数绑定、连接失败清理、健康检查和迁移失败行为；真实 SQL Server 的首建与重复启动行为有集成验证记录。

**S-05 处理记录（2026-09-12）**：metadata 新增 22 个独立用例，验证六类参数与 null 绑定、连接失败清理、健康探针、结果转换、文件加载顺序及迁移失败停止。修复连接和清理同时失败时原始错误被覆盖的问题。包测试与根 `pnpm test` 已通过；[SQL Server 集成入口](../ai-data/apps/data-access/tests/integration/sqlserver.integration.ts)及[环境说明](../ai-data/TESTING.md)已完成。当前无专用 SQL Server 环境，集成验证记录仅证明入口加载及缺配置错误提示，真实数据库行为仍待验收。

### R-12 元数据库密码的配置约定不一致

- [ ] 确认约定并同步实现、文档和测试。
- **要求与现状**：[data-access-design.md](./data-access-design.md) 第 3 节要求敏感连接值使用密钥系统或引用；`das-config.ts` 明确允许启动配置保存元数据库密码明文，并将 password 定义为必填字段。
- **位置**：[das-config.ts](../ai-data/apps/data-access/src/config/das-config.ts)，第 46 行。
- **影响**：部署与验收人员无法依据同一约定配置服务。
- **验收**：先确定最终启动凭据来源及保护方式，再统一 Schema、加载流程、示例配置和设计说明。本条不记录实际配置值。

### R-13 外连接可选侧行权限仍写入 WHERE

- [x] 完成对象过滤注入与外连接语义验收（2026-09-13）。
- **要求**：保留主记录的外连接，其可选侧授权限制放入对象预过滤或相应 ON 条件。
- **修复前证据**：API 将注入的行策略统一放入 `query.filters`。使用 LEFT JOIN 和右侧科室权限，已复现输出查询级过滤 `d.dept = A`；DAS 将其编译到 WHERE。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 173 至 212 行。
- **影响**：未匹配可选记录的主记录被排除，统计结果与既定外连接语义不符。
- **验收**：覆盖主记录有授权匹配、仅有未授权匹配、完全无匹配三类情形；主对象权限独立生效。合同暂不支持时返回能力限制。

**处理记录（2026-09-13）**：API 按每个对象别名把行权限及强制范围注入 `from.filters` / `joins[].filters`，保留原查询级业务筛选。DAS 在关联前过滤各对象。LEFT/RIGHT JOIN 的授权匹配、仅未授权匹配和无匹配均在 R-09 所列编译执行测试验收，主对象权限独立生效，同对象多别名分别过滤。

### R-14 行策略求值、操作符与多角色合并不完整

- [x] 完成关系查询有效权限范围计算与验收（2026-09-13）。
- **要求**：支持已发布的操作符与 `value_from` 求值；同对象多个允许范围按既定 OR 规则合并，每个对象及其别名独立受限。
- **修复前证据**：仅处理存在固定 value 的 `eq/in` 策略，其他操作和上下文引用被过滤掉；多条策略统一以 AND 注入。已复现 `neq` 策略消失，以及科室 A、B 两个允许范围生成 `dept = A AND dept = B`。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 173 至 212 行；[permission-policy.ts](../ai-data/packages/contracts/src/permission/permission-policy.ts)。
- **影响**：可能漏掉访问限制，也可能把有效允许范围错误收窄为空。
- **验收**：覆盖全部已声明操作符、上下文引用、多个角色、无行限制角色及同对象多别名；无法求值的限制明确拒绝，不能静默丢弃。

**处理记录（2026-09-13）**：[行策略求值](../ai-data/apps/api/src/query/row-policy-filters.ts)支持 `eq`、`neq`、`in`、`not_in`、`between`、`is_null`、`not_null`，同对象允许范围按 OR 合并，强制范围和对象业务条件按 AND 合并。只计算对该对象具有访问权的角色；其中存在无行策略的角色时，其允许范围不额外受限，强制范围仍生效。每个对象别名独立注入，强制条件按资源匹配，无法验证的匹配条件明确拒绝。

`value_from` 仅从认证上下文白名单读取：`user_id`、`organization_id` 和可信 `permissionContext.department_ids`。当前 SQL 认证仓储尚未提供部门集合，依赖该值的策略会拒绝查询；策略字段若在授权目录中缺少可信类型也拒绝。关系查询之外的参数授权仍由 R-15 跟踪。[授权测试](../ai-data/apps/api/tests/query/query-policy-authorization.test.ts)包含本条与 R-13、R-16 共 50 个场景；[认证服务测试](../ai-data/apps/api/tests/auth/auth-service.test.ts)验证可信权限上下文传递。

### R-15 参数化查询的行列权限和脱敏未落实

- [x] 完成受控参数化查询授权与自动化验收（2026-09-13）。
- **要求**：有行限制时强制绑定可靠权限参数；无法表达则拒绝。固定输出须满足列权限，受限列按规则脱敏。
- **现状与证据**：参数化分支只检查基础参数，没有消费行策略、验证完整固定输出或构建脱敏规则。使用有科室行限制且没有权限参数绑定的模拟数据集，已复现请求仍被签发，parameters 和 output_masks 均为空。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 57 至 63 行、第 216 至 243 行。
- **影响**：参数化数据集可能绕过当前用户的行范围或固定输出限制。
- **验收**：覆盖参数绑定缺失、范围冲突、输入越界、固定返回列禁止访问、需脱敏列及普通默认参数；DAS 收到的是完整授权后的参数与输出规则。

**处理记录（2026-09-13）**：[参数化授权](../ai-data/apps/api/src/query/parameterized-authorization.ts)依据完整原始输出清单逐列授权及生成脱敏规则，任何固定列不可访问均拒绝整个调用。完整原始列仅供 API 内部授权使用，不随用户目录返回。API 重建并签名 `expected_output`，调用方不能修改审核清单。

业务配置新增 `query_permission_bindings`，将权限字段绑定到已验收的标量 `eq` 参数。角色允许范围按 OR 合并，强制范围按 AND 合并；支持 `eq/in` 权限条件树。省略参数时仅自动补入全树能证明唯一的值，多值范围要求明确选择合法值；范围无法表达、绑定不完整、冲突或推导超过 4096 个候选状态均拒绝。普通默认参数按类型校验后写入最终签名请求；数据源是否实际按绑定字段限制结果，仍须管理员验收。

[参数授权测试](../ai-data/apps/api/tests/query/parameterized-authorization.test.ts)58 项覆盖缺省与默认值、多角色与跨字段 OR、强制范围、越权、类型、完整输出、脱敏及篡改声明。新增场景先复现失败再通过，关系查询权限回归继续通过。

### R-16 组合关联只校验提交条件的子集

- [x] 完成批准关联的完整匹配与验收（2026-09-13）。
- **要求**：一条批准关系的全部 column_pairs 共同组成关联条件，同对象对的多条候选关系各自保持完整。
- **修复前证据**：原逻辑查找目标对象的第一条关系，并检查提交的每个条件是否在其中，没有要求提交全部字段对。配置 `id + org` 组合键、仅提交 id 条件，已复现通过授权。
- **位置**：[query-authorization-service.ts](../ai-data/apps/api/src/query/query-authorization-service.ts)，第 153 至 170 行。
- **影响**：关联可能扩大匹配范围、重复统计或连接到错误记录。
- **验收**：缺少任一必需字段对、混合不同候选关系或提交额外条件时明确拒绝；完整选择任一批准关系可通过；多 Join 的实际左右对象和别名正确匹配。

**处理记录（2026-09-13）**：[关联校验](../ai-data/apps/api/src/query/approved-joins.ts)要求当前 Join 完整匹配任一候选关系的全部列对；支持字段对顺序变化和关联此前已加入的任一对象别名。缺少、重复、额外列对，混合关系、混合左侧别名或引用未加入对象均拒绝。相关用例包含在 R-14 所列 50 项授权测试中。

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

### 2026-09-13 本轮修改验收

本轮完成 R-09 对象预过滤、R-13、R-14、R-16，以及 R-06 结果转换和 R-10 结果边界校验。根级 `pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 均通过，`git diff --check` 通过。全量测试共 541 项：工程规则 15、contracts 60、metadata 22、API 169、DAS 275。

对象过滤与 API 授权经独立只读复核，另行复跑 127 项通过；日期与驱动在 UTC 环境下的 39 项测试通过。数据库驱动验证使用已安装驱动的类型定义、实际解析器及连接替身；外连接语义另用内存 SQLite 执行验证。四类目标数据库的实际连接、原生类型及部署链路仍需专用环境集成验收。

### 2026-09-13 参数化查询、审计与资源控制验收

R-07、R-15 的可信参数与固定输出授权，以及 R-04、R-08 的审计、超时、排队和取消已接通。根级 `pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过，`git diff --check` 通过。全量测试 698 项：工程规则 15、contracts 77、metadata 22、API 230、DAS 354。

审计、资源控制与参数授权经独立只读复核，另行复跑 10 个文件、136 项通过，配置指南与实现一致。取消传播包含本地真实 HTTP 连接；数据库中断使用已安装驱动接口与替身验证，尚未连接真实数据库。新过程迁移、各目标库的真实调用与清理，以及 SQL Server 审计持久化仍待专用环境验收。

### 2026-09-13 分层聚合与关联统计验收

根级 `pnpm format:check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过。全量测试 852 项：工程规则 15、contracts 135、metadata 22、API 284、DAS 396。

新增共享合同先复现 14 项失败，API 初轮 25 项行为失败与复核补充的 10 项能力边界失败、DAS 初轮 16 项失败及 SQL Server AVG 编译失败均已修复后通过。查询验签另验证主对象及关联对象的内层聚合篡改会被拒绝。

[分层聚合指南](../ai-data/RELATIONAL-AGGREGATION.md)中的 JSON 示例经过真实 API 业务配置校验、查询授权、DAS 规划和 SQL 编译，在内存 SQLite 执行得到 3 次就诊、50 元费用、3 张处方的人工基准。该跨层核对使用合成目录、内存仓储和签名替身，真实签名由独立验签测试覆盖；未连接真实业务数据库。

## 5. 建议处理顺序

1. 在专用数据库环境验收 R-04、R-05、R-06、R-07、R-08、R-11 的实际驱动、迁移和审计链路；开放参数化数据集前确认 R-15 的权限绑定与实际数据源语义一致。
2. R-12：统一元数据库启动凭据的配置与保护约定。
3. R-09：查询对象过滤、分层聚合、唯一键和关联基数已实现；指标版本及总计规则、运行恢复、证据和报告合同按对应业务阶段推进。

每项记录关闭时，补充处理日期、变更文件及验证结果；代码位置变化后同步修正文档链接。
