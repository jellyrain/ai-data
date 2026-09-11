# AI BI Contracts 合同说明

版本：v0.2  
状态：设计基线已确认，合同实现持续开发  
设计基线日期：2026-09-11  
代码位置：`../ai-data/packages/contracts`

本文区分当前 Schema 与待补齐的合同要求。运行恢复、外连接条件位置和复合聚合等要求须完成对应 Schema、API 处理与 DAS 执行支持后验收；设计确认不代表代码已实现。

## 1. Contracts 是什么

`@ai-data/contracts` 是 Web、API、Codex Harness 和 Data Access Service 共用的边界定义。

每一份合同同时提供：

- **Zod Schema**：运行时校验外部输入和服务间数据；不符合合同的数据在入口被拒绝。
- **TypeScript Type**：从同一个 Schema 自动推导的开发期类型。
- **测试**：合法、非法和边界输入的固定行为。

应用代码统一从 `@ai-data/contracts` 导入，不依赖 `src` 内部文件路径。

## 2. 目录规则

```text
packages/contracts/
├─ src/
│  ├─ catalog/         # API 目录与业务配置
│  ├─ health/          # 数据源健康状态与服务心跳
│  ├─ errors/          # 跨服务错误码
│  ├─ api-tools/       # API 提供给模型的工具输入输出
│  ├─ permission/      # API 维护的权限策略定义
│  ├─ query/           # 查询 DSL 与查询结果
│  ├─ sse/             # API 到 Web 的流式事件
│  └─ index.ts         # 唯一公共导出入口
└─ tests/              # 与 src 分类一一对应的合同测试
```

每个分类中：

- `*.ts` 只定义和导出运行时 Zod Schema。
- `*-types.ts` 只从 Schema 推导并导出 TypeScript 类型。
- `src/index.ts` 统一导出所有 Schema 和类型。

## 3. 每部分职责

| 分类       | Schema 文件              | Type 文件                      | 作用                                                                                                                                                                                                    | 主要使用方                                         |
| ---------- | ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| catalog    | `dataset.ts`             | `dataset-types.ts`             | 定义 API 提供给模型的统一扁平表目录：保留底层对象真实 `kind`（表、视图、存储过程或 API 数据集），同时统一返回字段、字段说明、类型、可空性、新鲜度和存储过程/HTTP API 的输入参数；不暴露底层连接器类型。 | API 目录服务、模型工具。                           |
| catalog    | `api-dataset.ts`         | `api-dataset-types.ts`         | 定义 API 额外维护的数据集业务说明、查询能力收窄、参数收窄与默认值、带描述的组合字段批准关系和字段默认脱敏策略。                                                                                         | API 管理端、权限与查询编排。                       |
| health     | `health.ts`              | `health-types.ts`              | 定义按 `source_id` 报告的数据源健康状态和 Data Access Service 服务心跳；不描述数据库连接器能力。                                                                                                        | Data Access Service 与 API。                       |
| access     | `access-context.ts`      | `access-context-types.ts`      | 定义 API 发送给 Data Access Service 的审计上下文和结果脱敏授权信息。                                                                                                                                    | API 构建；Data Access Service 验证和执行。         |
| errors     | `errors.ts`              | `error-types.ts`               | 定义跨服务统一错误码及结构化错误体；每个错误码有明确语义，`message` 只提供安全的人类可读说明。                                                                                                          | Web、API、Harness、Data Access Service。           |
| api-tools  | `api-tools.ts`           | `api-tools-types.ts`           | 定义 API 提供给模型的 `search_catalog`、`list_datasets`、`describe_dataset`、`query_dataset` 工具输入输出。                                                                                             | Harness/模型调用；API 实现。                       |
| permission | `permission-policy.ts`   | `permission-policy-types.ts`   | 定义 API 管理端保存的角色对象权限、列权限和行策略原始规则。                                                                                                                                             | API 管理端和权限计算服务。                         |
| query      | `query-dsl.ts`           | `query-dsl-types.ts`           | 定义 API 发送给 Data Access Service 的关系查询和参数化查询：关系查询支持 Join、字段、筛选、聚合、分组、排序；参数化查询只提交输入参数与可选行数限制，返回字段由数据集固定。                             | API 生成；Data Access Service 校验和编译。         |
| query      | `data-access-request.ts` | `data-access-request-types.ts` | 定义 API 到 Data Access Service 的内部查询封装：引用 `access` 授权上下文、已合并授权条件的 `query`，以及覆盖两者的 `signature`。                                                                        | API 构建；Data Access Service 验证和执行。         |
| query      | `query-result.ts`        | `query-result-types.ts`        | 定义 Data Access Service 返回的标准化结果、列信息、截断状态和可选新鲜度。                                                                                                                               | Data Access Service 返回；API、Web、Harness 使用。 |
| sse        | `sse-events.ts`          | `sse-events-types.ts`          | 定义 API 流式推送给 Web 的运行、思考摘要、进度、工具、澄清、表格、图表、完成、失败和取消事件。                                                                                                          | API 推送；Web 渲染。                               |

## 4. API 与 Data Access Service 的授权上下文

每次 API 调用 Data Access Service 时，API 使用专门的 JWT/JWS 库（MVP 采用 `jose`）签发短时 JWT，并携带由 API 生成的内部请求。JWT 的签发、验签、密钥与请求头传输仍属于 API 与 Data Access Service 的认证授权实现。API 工具的业务入参只包含模型需要的查询内容，不能接收或信任模型、前端传入的用户、角色或授权范围。

```text
用户请求
  ↓
API 认证并读取用户、角色和权限策略
  ↓
API 校验对象、字段、Join、参数、统计规则和权限，按关联语义确定各条件的位置，生成最终可执行 DSL
  ↓
API 签发 JWT，在内部请求头携带 JWT，并提交 `{ access, query, signature }`
  ↓
Data Access Service 验证 JWT、`signature` 与内部请求；映射本地白名单、收紧资源限制并执行只读查询
```

### 4.1 API 保存的原始权限策略

API 维护的数据是可配置的原始策略，例如：

```text
妇科主任
├─ 可读取门诊就诊表、费用明细表
├─ 可使用允许字段
└─ 门诊就诊表按执行科室限制为妇科范围
```

原始策略使用 `permission/permission-policy.ts` 的合同保存和校验。

### 4.2 已签名查询上下文

`access` 保存 DAS 审计和结果脱敏所需的信息，业务授权已经表现为最终 `query` 中的对象范围、条件位置和受控参数。API 在签名前确定关联、聚合、去重及过滤逻辑；DAS 对该请求完成校验、执行、匿名化/脱敏和返回。物理对象映射与 SQL 编译保持 DSL 的既定语义。DAS 只接受 API 签名后的 `access` 与 `query`：

```ts
{
  user_id: "user-001",
  organization_id: "organization-001",
  analysis_run_id: "run-001",
  policy_version: 12,
  expires_at: "2026-08-25 15:00:00",
  output_masks: [
    {
      result_column: "patient_phone",
      rule: {
        type: "partial_mask",
        prefix_length: 3,
        suffix_length: 4,
        mask_character: "*"
      }
    }
  ]
}
```

| 字段                                            | 作用                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `user_id`、`organization_id`、`analysis_run_id` | 记录查询来源与审计关联。                                           |
| `policy_version`、`expires_at`                  | 记录 API 使用的策略版本和短时授权窗口。                            |
| `output_masks`                                  | API 计算、签名并指定的结果列部分脱敏规则；DAS 在查询结果出口执行。 |

JWT 同时包含标准 claims：`iss`（API）、`aud`（Data Access Service）、`iat`、`nbf`、`exp` 和唯一 `jti`。请求签名覆盖 `access` 和 `query`。过期、签名无效、签发方或接收方不匹配时，Data Access Service 拒绝请求。

## 5. 数据查询链路

```text
Web
  ↓ 用户问题
API
  ↓ JWT + 会话信息
Codex Harness
  ↓ API Tools：目录工具或 query_dataset
API
  ↓ Authorization 请求头 + 已签名查询请求
Data Access Service
  ↓ 映射本地对象、编译参数化查询并执行结果脱敏
SQL Server / HTTP API
  ↓ 标准化查询结果
API
  ↓ SSE 事件
Web
```

Data Access Service 的查询目标可以是 Oracle、MySQL、SQL Server、PostgreSQL 或已扁平化的业务 HTTP API。底层适配由 Data Access Service 内部完成，公共合同只约束统一 Dataset、查询 DSL、结果和健康状态；模型工具输入输出由 `api-tools` 合同约束。

## 6. 接口方向与流式方式

Contracts 必须明确每个合同的数据流向，避免后续实现把单向数据合同误做成双向业务接口。这里的“单向/双向”指合同数据的拥有方和传递方向，不等同于底层网络连接是否使用请求/响应：

| 边界                         | 调用方向                                                                 | 传输方式                    | 是否流式                                       | 合同范围                                                                      |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Web → API                    | Web 发起请求                                                             | HTTP 请求/响应              | 否；用户消息、选项提交、取消和重试都是独立请求 | API 请求合同                                                                  |
| API → Web                    | API 推送运行过程与结果                                                   | SSE 长连接                  | 是，单向服务端到浏览器                         | `sseEventSchema`；每个事件带 `conversation_id`、`analysis_run_id`、`sequence` |
| API ↔ Codex Harness          | API 创建并驱动 Agent，Harness 返回过程事件、工具调用和结果               | SDK/App Server 内部双向调用 | 运行事件可连续返回；不对浏览器暴露             | Agent 运行上下文和受控工具合同                                                |
| 模型 ↔ API Tools             | 模型调用 API 工具，API 返回目录、查询结果或错误                          | API 请求/响应               | MVP 按一次工具调用返回完整结构化结果           | `api-tools`、`catalog`、`query-result`、`errors`                              |
| API ↔ Data Access Service    | API 提交 `access`、已授权 DSL 和整体签名，数据访问服务返回查询结果或错误 | 内部请求/响应               | MVP 不定义业务数据流式传输                     | `data-access-query-request`、`query-result`、`errors`                         |
| Data Access Service → API    | 数据访问服务定期报告实例存活和各数据源健康快照                           | 内部 HTTP 心跳请求          | 否；每次心跳是独立请求                         | `health`（`dataAccessHeartbeatSchema`）                                       |
| Data Access Service ↔ 数据源 | 数据访问服务访问底层数据库或 HTTP API，并输出统一表结构                  | 内部实现请求/响应           | 不向模型暴露底层数据源流                       | `catalog`、`query-result`                                                     |

### 6.1 合同数据流向

| 合同                        | 数据流向                               | 说明                                                                                       |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `catalog / dataset`         | API → 模型                             | API 向模型工具返回表结构和业务目录；模型不能写回目录配置。                                 |
| `api-tools`                 | 模型 → API → 模型                      | 工具协议是请求/响应双向交互；JWT 不属于模型工具业务参数。                                  |
| `query-dsl`                 | API → Data Access Service              | API 提交受控查询意图，数据访问服务只校验和执行，不反向修改 DSL。                           |
| `data-access-query-request` | API → Data Access Service              | API 将已授权的 DSL 与审计、脱敏上下文组成 `{ access, query, signature }`；签名覆盖前两项。 |
| `query-result`              | Data Access Service → API              | 数据访问服务返回标准化结果、列信息和可选新鲜度，API 再决定如何返回给模型/Web。             |
| `data-access-heartbeat`     | Data Access Service → API              | 数据访问服务报告实例状态和数据源健康快照；API 根据最近一次接收时间判断是否继续调度。       |
| `sse-events`                | API → Web                              | SSE 事件严格单向推送；Web 的消息、选择、取消和重试另走 HTTP 请求合同。                     |
| `errors`                    | 各调用方 → 被调用方；被调用方 → 调用方 | 请求错误由接收方返回，错误码结构双向复用，但不构成状态同步流。                             |

### 6.2 Data Access Service 心跳与健康监控

`dataAccessHeartbeatSchema` 定义 Data Access Service → API 的单向服务心跳。它不是业务查询结果，也不通过模型工具或 SSE 暴露给 Web。

- Data Access Service 按部署配置的固定间隔向 API 注册并发送心跳；心跳至少包含 `service_id`、`service_protocol`、`service_port`、`status`、`sent_at` 和当前 `sources` 健康快照，可附带 `service_version` 与安全的 `message`。DAS 从实际监听地址识别协议，API 使用心跳 TCP 连接的远端 IP、协议和端口生成并保存内部 `service_url`；该地址不由 DAS 请求体指定。
- API 按 `service_id` 保存最近一次有效心跳，并使用接收时间判断存活。`status: healthy` 只表示发送方当时可以接收查询，不代表每个数据源都健康。
- 心跳超过 API 配置的失联阈值未收到时，API 必须将该服务视为不可用并拒绝向其发送新的查询；恢复收到有效心跳后再允许调度。阈值和发送间隔属于部署配置，不写入业务合同。
- `sources` 中的 `sourceHealthSchema` 表示单个 `source_id` 的连接状态。单个数据源 `unhealthy` 时，API 只拒绝路由到该数据源的查询；不影响同一服务中其他健康数据源。
- 心跳通道只传递状态和诊断文本，不携带连接串、凭据、查询结果或目录数据。心跳请求沿用 API 与 Data Access Service 的内部认证和传输安全边界。

方向约定：

- SSE 只能由 API 向 Web 推送，浏览器不能通过 SSE 通道回传业务请求；回传统一使用 HTTP 接口。
- API 工具调用是双向请求/响应，但一次调用只对应一个明确的输入和输出，不把 JWT、权限配置或隐式状态放入模型工具参数。
- `table`、`chart`、`final_answer` 等结果通过 API SSE 事件逐项推送；断线恢复依靠 `sequence`，不是重新建立一个双向流。
- `thinking` 事件用于展示面向用户的分析摘要和阶段（理解、规划、查询、校验、总结），不传输模型内部完整推理链、JWT、权限配置、原始 DSL 或敏感数据。
- 后续若需要数据访问服务级流式返回，必须新增明确的流式合同和结束事件，不能改变现有同步工具合同的语义。

### 6.3 统一表目录、参数化查询与组合 Join

- Data Access Service 无论底层是数据库表、存储过程还是 HTTP API，都必须向 API 返回统一的扁平 `dataset`；`dataset.kind` 必须保留真实对象类型（`table`、`view`、`stored_procedure`、`api_dataset`），不能为了统一输出改写成 `table`。底层连接器类型不进入公共合同。
- `dataset.columns` 只描述最终返回表的字段；存储过程或 HTTP API 的输入条件放在 `dataset.query_parameters`，不能把输入参数误当成返回列。
- Data 在 `dataset.query_capabilities` 中提供基础过滤、排序、分组和聚合能力；该字段是可选的限制声明，未填写时 table/view 默认全部标准能力，stored procedure/api_dataset 只按其 `query_parameters` 定义执行。API 的 `apiDatasetConfig.query_capabilities` 只允许进一步收窄；未配置表示继承 Data，空数组表示明确禁止。
- 统一数据类型是 `string`、`integer`、`decimal`、`boolean`、`date`、`datetime`、`buffer`。`date` 使用 `YYYY-MM-DD`，`datetime` 使用 `YYYY-MM-DD HH:mm:ss`，`buffer` 在 JSON 中使用 Base64 文本；无法映射的数据库原生类型归为 `string`。
- 字段查询条件和输入参数携带真实 `data_type`；API 可通过 `query_parameter_policies` 收窄参数并提供默认值。
- `relational_query` 用于表数据，支持过滤、Join、聚合、分组、排序和可选行数限制；`order_by` 每项包含字段和 `asc/desc` 方向。`parameterized_query` 用于存储过程或 HTTP API，只提交 `parameters` 和可选行数限制，返回字段由数据源固定，不由模型选择。
- 当前 `relational_query.filters` 是查询级递归条件树，组使用 `logic: and | or`，`between` 的值必须是两个元素的数组。API 使用查询别名表达条件，依据对象权限、Join 类型和业务筛选语义确定执行位置：查询级条件写入 `filters`，外连接可选侧的授权限制需要表达为对象预过滤或相应 `ON` 条件，主表权限独立生效。DAS 执行 API 已确定的条件结构。
- API 负责字段可见性、操作能力和批准关系校验。`access.output_masks` 只包含需要在 DAS 结果出口执行的 `partial_mask` 规则。
- `approved_relations` 是关系数组；每条关系必须有业务 `description` 和至少一个 `column_pairs`。多个字段对在执行时使用 `AND` 连接，同一对对象可以配置多条候选关系，模型只能从已批准关系中选择。

#### 6.3.1 关系查询的合同完善要求

API 业务配置管理数据集粒度与唯一键、批准关系及关联基数、指标的去重键、聚合方式和总计规则。API 生成 DSL 时验证这些规则，确保关联后每条业务记录按指标定义参与统计；费用与处方等多个明细对象需要分别聚合时，聚合层次和最终关联均由 API 写入最终 DSL。分组间存在重复业务记录的去重指标，其总计按完整授权范围重新计算；比率指标按总分子与总分母计算。

当前 Schema 的 Join `on` 表达字段等值关系，`select` 表达字段及基础聚合。对象预过滤、带值的 Join 条件或复合聚合所需的结构，在启用对应查询前须补齐共享合同、API 生成校验、DAS 编译执行和边界测试。API 对现有合同无法正确表达的查询返回明确的能力限制。DAS 的校验与编译保持收到的 DSL 语义。

#### 6.3.2 参数化查询的授权合同

对存在行权限限制的存储过程或 HTTP API 数据集，API 业务配置必须声明权限范围与受控参数的绑定关系，并验证数据源参数能够实际限制返回范围。API 根据当前身份计算权限参数，校验用户输入与授权范围；默认值只承担普通参数补齐。权限条件无法映射到受控参数，或参数不能保证授权范围时，API 拒绝该次查询。

返回列由数据集固定。API 在发送前确认固定输出满足当前用户的列权限，并为需脱敏列生成 `access.output_masks`；当前执行合同无法保证列权限时拒绝查询。DAS 依照已签名参数和结果规则执行。

### 6.4 运行、澄清与事件关联合同

运行合同以 `organization_id`、`user_id`、`conversation_id`、`analysis_run_id` 确定归属。API 对消息、运行操作、事件订阅和事件回放逐次校验访问权；Agent 的会话上下文按相同归属隔离。

需补齐并验收以下合同：

- 状态：`created`、`running`、`waiting_clarification`、`cancelling`、`completed`、`failed`、`cancelled`；合法转换及执行恢复见技术方案。终态保持稳定。
- 澄清：持久化 `clarification_id`、问题、稳定选项 ID、所属运行和回答状态；回答绑定当前待处理问题，并通过幂等键与原子状态更新实现一次有效提交。
- 执行：持久化租约持有者、到期时间和递增执行代次；所有步骤与结果提交校验当前执行代次，隔离过期执行器的写入。
- 事件：`sequence` 在每个运行内单调递增且唯一；状态转换和对应事件在同一事务持久化，SSE 按已提交事件推送和回放。
- 工具与证据：每次工具调用、查询及产物具有稳定关联标识；同一工具的多次调用可区分，恢复和重试能关联既有结果。

当前 SSE Schema 已提供运行 ID 与事件序号；澄清标识、执行代次及操作请求幂等合同须在运行恢复阶段补齐。第一版同一会话串行推进运行，等待澄清属于原运行；不同会话可并行执行。

### 6.5 指标、分析证据与报告合同

- 每个指标定义固定日期依据。门诊人次（挂号时间）与门诊人次（就诊时间）使用独立指标 ID；执行记录保存指标 ID、版本、实际对象、字段、筛选、关联和数据新鲜度。
- Skill 提供通用分析方法与可选案例；模型依据运行时指标知识、目录和查询证据选择下一步。API/工具承担确定性计算、权限和状态控制，并持久化步骤、假设、查询及证据引用。分析路径随证据形成，具体方法通过真实案例持续完善。
- 报表模板按当前访问者权限执行。历史报告快照的访问同时要求报告权限和覆盖快照完整数据范围的权限；表格、图表、文字结论、证据及导出遵循相同授权检查。
- 保存快照时记录其数据范围与字段授权依据，供后续读取校验。访问者权限不足，或系统无法确认覆盖范围时，拒绝原快照访问；可按访问者权限创建新的执行结果，原快照保持历史记录。

## 7. 开发约定

- Schema 字段、Zod 规则和 TypeScript 类型都必须写中文注释。
- 对象 Schema 使用 `.strict()`，服务边界只接受合同中声明的字段。
- 所有业务数据查询通过 `queryDslSchema`，Data Access Service 编译为参数化只读查询。
- API 负责计算授权范围并使用私钥签发 JWT；Data Access Service 使用公钥验签后再校验和执行。
- 合同变更必须同步更新对应的 `tests`，并执行 `format:check`、`typecheck` 和 `test`。
