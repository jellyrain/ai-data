# Data Access Service 设计合同

版本：v0.2  
状态：MVP 设计基线已确认，实现按开发清单验收  
设计基线日期：2026-09-11  
关联文档：[technical-design.md](./technical-design.md) · [contracts.md](./contracts.md) · [dependencies.md](./dependencies.md)

## 1. 定位

Data Access Service 是一个独立、只读的数据访问服务。API 完成全部业务查询处理并生成最终可执行 DSL，DAS 负责校验、执行、匿名化/脱敏和返回。它对 API 的每次查询请求无会话状态：不保存用户会话、分析运行状态、查询结果或 API 的原始权限策略；每次执行以当前短时 JWT、`{ access, query, signature }` 及本地对象白名单为准。它通过可插拔连接器访问 Oracle、MySQL、SQL Server、PostgreSQL、HTTP API 等数据源。

DAS 使用 `das.config.json` 完成启动引导，并将运行元数据和审计数据持久化到自己的 SQL Server。该 JSON 配置文件保存 API Host、内部端点、JWT 验签公钥、DAS 元数据 SQL Server 的连接配置、TLS 和实例标识；SQL Server 保存数据源连接配置及其 `secret_ref`、允许向 API 暴露的对象配置和查询执行审计。它们是服务运行元数据，不是 API 的用户、角色或原始权限策略。

它只接受 API 发起的受信任内部查询请求：

```text
Authorization: Bearer <短时 JWT>
{ access, query, signature }
```

`access` 保存审计关联信息、策略版本、过期时间和 API 已计算的结果脱敏规则；`query` 是已完成对象、字段、Join、参数、统计规则与权限校验的最终 DSL，关联、聚合、去重、条件位置及参数均已确定；`signature` 覆盖 `access` 和 `query`。`Authorization` 负责调用方身份与短时授权，`signature` 保护内部请求体完整性。它只返回结构化查询结果和执行状态。目录由 API 管理并提供给模型；数据访问服务不接收自由 SQL，不保存业务数据、用户会话数据、API 原始权限策略或查询结果。

## 2. 职责边界

| 组件                  | 负责内容                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| API                   | 登录认证、角色权限、关联关系和指标统计规则配置，完成业务校验及查询构建，生成并签名最终可执行 DSL。                                        |
| Codex Harness         | 依据 Skill、指标知识、API Catalog 和查询证据动态决定分析路径，调用 API 工具。                                                             |
| Data Access Service   | 管理 `das.config.json`、SQL Server 元数据与审计；验签、映射本地对象白名单、收紧资源限制、编译执行 DSL，并在结果出口执行已签名的脱敏规则。 |
| 数据源连接器          | 声明能力、编译并执行具体数据源请求。                                                                                                      |
| SQL Server / 外部 API | 保存或提供业务数据并执行各自的只读请求。                                                                                                  |

浏览器和 Agent 都不能直连业务数据源。Agent 也不能自行声明用户、角色、可读对象或行过滤条件。

## 3. 请求无状态、配置文件与数据库存储

Data Access Service 对查询请求无状态，但使用独立的 `das.config.json` 和 SQL Server 存储运行元数据与审计。`ai_bi_meta` 仍由 API 统一管理，至少保存：

```text
roles
user_roles
data_sources
catalog_objects
role_object_permissions
role_object_row_policies
role_object_column_permissions
```

DAS 的唯一启动配置文件 `das.config.json` 至少包含：

```text
api_base_url               # API Host 和内部调用根地址
api_endpoints              # 心跳、目录同步等内部端点
jwt_verification_public_key # API 签发 JWT 的验签公钥
metadata_sqlserver         # DAS 元数据 SQL Server 的连接配置或 secret_ref
tls_and_instance           # TLS、服务实例标识和非敏感运行参数
```

DAS 自己的 SQL Server 元数据至少包含：

```text
data_source_configs        # source_id、连接器类型、secret_ref、目标数据库或 Oracle 连接方式与目标值、超时、并发和成本限制
exposed_source_objects     # 允许向 API 返回目录并接受查询的对象白名单及基础能力
api_dataset_response_mappings # HTTP API 虚拟表的固定请求、行路径、字段 JSONPath 与类型转换配置
query_audit_logs           # DAS 实际执行、拒绝、超时和失败的审计事件
```

API 对接地址和 JWT 验签公钥必须在 DAS 连接元数据数据库前可用，因此只由 `das.config.json` 加载，而不从数据库读取。配置文件中的敏感连接值通过密钥系统或 `secret_ref` 引用，不写入普通配置文件。DAS 的对象暴露白名单仅限定 API 可以发现和请求的物理对象，不替代 API 对最终用户计算的对象、字段和行级权限。

Data Access Service 在每次请求中验证 API 签发的短时访问凭证与请求签名。API 读取用户、角色和权限策略，完成对象、字段、Join、参数与权限校验，按查询别名和关联语义确定条件位置及受控参数。DAS 信任这份已签名的最终 DSL，按自身对象白名单和资源限制编译执行。Catalog 由 API 管理并提供给模型；DAS 只执行 API 在 `access.output_masks` 中给出的结果脱敏规则。

```json
{
  "user_id": "u_123",
  "organization_id": "org_001",
  "analysis_run_id": "run_456",
  "policy_version": 18,
  "expires_at": "2026-08-25 20:05:00",
  "output_masks": [
    {
      "result_column": "patient_phone",
      "rule": {
        "type": "partial_mask",
        "prefix_length": 3,
        "suffix_length": 4,
        "mask_character": "*"
      }
    }
  ]
}
```

访问凭证必须由 API 私钥签名，Data Access Service 使用对应公钥验签。JWT 必须校验签名、`iss`、`aud`、`iat`、`nbf`、`exp` 和 `jti`；其有效期应保持很短。Data Access Service 还必须验证 `signature` 与收到的 `access`、`query` 完全匹配。前端、模型和工具参数都不能传裸 `role_id` 作为授权依据。

内部查询 JWT 使用 `token_use: das_query`，必须包含与 `access` 一致的 `sub`（用户）、`org_id`、`analysis_run_id` 和 `policy_version`，以及非空 `jti`。API 以同一秒设置 `iat` 和 `nbf`，`exp` 为 60 秒后；DAS 同时检查签发时间处于过去 60 秒内。API 将 `access.expires_at` 设为当前时间 55 秒后，按东八区文本输出；DAS 显式按 `+08:00` 解析，到达截止时刻即拒绝。JWT 与访问上下文的有效期均须满足，服务机器的本地时区不改变授权截止时刻。

JWT 的签发与验签使用专门 JWT/JWS 库实现（MVP 采用 `jose`）。`queryAccessContextSchema` 与 `dataAccessQueryRequestSchema` 只固定 API/Data Access Service 的数据结构；密钥托管、签名算法、重放防护和传输认证属于后续部署安全设计。

## 4. 权限模型

权限以“角色对数据对象”的形式配置，不按科室、指标、业务口径或 Join 关系配置。一个角色在管理页面中批量勾选当前数据源目录中的表、视图或 API 资源是否可读。

```text
角色 -> 数据对象 -> allow / deny
                    -> 可选行过滤 DSL
                    -> 可选列操作限制
```

没有 `allow` 的对象默认不可见、不可描述、不可查询。拥有对象读取权限但没有行过滤规则时，可读取该对象的全部授权数据。

字段权限与字段敏感性由 API 管理和计算，不由 Data Access Service 根据字段名猜测。API 在组装请求前完成字段操作能力、字段可见性与 Join 的业务校验，只把最终可执行 DSL 发送给 DAS。MVP 的结果脱敏规则是 `partial_mask`：API 把返回列及规则写入已签名的 `access.output_masks`，DAS 仅在查询结果出口处理匹配的字符串列。DAS 不返回字段敏感等级，也不自行新增、放宽或推断脱敏规则。

### 4.1 行过滤 DSL

对支持关系过滤的数据源，管理页面可显示为易读条件，但原始策略与 API 计算出的最终行范围都必须是受限 DSL。API 在生成查询时保证对象权限独立生效，并按第 6 节确定外连接条件位置；DAS 校验收到的结构能被安全执行，无法执行时拒绝该查询。

```json
{
  "object_id": "clinical.surgery_record",
  "effect": "allow",
  "condition": {
    "field": "performing_dept_id",
    "op": "in",
    "value_from": "permission_context.department_ids"
  }
}
```

第一版支持的比较操作符仅限：`eq`、`neq`、`in`、`not_in`、`between`、`is_null`、`not_null`。`and` 与 `or` 仅用于查询 DSL 的过滤条件组。管理端策略中的 `value_from` 用于 API 在签发凭证前计算用户范围；数据访问服务收到的最终行范围只使用已求值的 `value`。值必须作为 SQL 参数绑定。

字段含义由配置者针对该表自行决定；数据访问服务不猜测“执行科室”“申请科室”或任何业务归属语义。

### 4.2 多角色规则

角色合并规则必须明确且可测试：

```text
显式 deny 优先于 allow
至少一个角色 allow 才可访问对象
同一对象的多个 allow 行过滤条件默认以 OR 合并
不同对象的行过滤条件相互独立
```

若组织不希望多角色导致范围扩大，应只为用户授予一个数据角色，或在 API 侧生成单一的有效角色集。

实现时先确定对该对象获准的角色集合，只合并这些角色的行策略。任一获准角色未配置行策略，则角色范围覆盖该对象全部记录；同一对象的强制身份范围仍与角色范围、对象级业务条件取 AND。同一对象使用多个别名时，每个别名分别应用范围；其他对象的强制策略不会被回退到主对象。策略格式、取值或字段无法验证时拒绝签发。

`value_from` 当前白名单为 `permission_context.user_id`、`permission_context.organization_id` 和 `permission_context.department_ids`。前两者直接来自已认证身份；`department_ids` 由服务端可信授权来源提供，本地 SQL 授权仓储目前尚未装配，缺失时返回 `POLICY_REJECTED`。策略引用的字段若被当前目录权限隐藏而无法取得可信类型，同样拒绝签发。

### 4.3 参数化数据集的权限执行

存储过程和 HTTP API 数据集存在行权限限制时，API 配置权限条件到受控参数的绑定关系，并验证这些参数实际约束返回范围。API 根据当前身份强制绑定权限参数、校验用户输入；普通参数默认值用于补齐输入。权限限制缺少对应参数或无法通过参数可靠执行时，API 拒绝查询。

参数化查询的固定返回列必须满足当前用户的列权限；API 为获准且需要脱敏的列生成 `access.output_masks`。当前合同无法保证固定输出的列权限时，API 拒绝执行。DAS 接收已确定的参数，执行请求并应用已签名的结果规则。

## 5. 查询 DSL

Agent 只能生成结构化查询 DSL。Data Access Service 不提供执行自由 SQL 的工具。

```json
{
  "type": "relational_query",
  "source_id": "clinical_reporting",
  "from": { "object_id": "clinical.surgery_record", "alias": "s" },
  "joins": [
    {
      "type": "left",
      "object_id": "clinical.surgery_application",
      "alias": "a",
      "on": [
        { "left": "s.application_id", "op": "eq", "right": "a.id" },
        {
          "left": "s.organization_id",
          "op": "eq",
          "right": "a.organization_id"
        }
      ]
    }
  ],
  "select": [
    { "aggregation": "count", "field": "s.id", "as": "surgery_count" }
  ],
  "filters": { "logic": "and", "items": [] },
  "group_by": [],
  "order_by": [],
  "limit": 100
}
```

存储过程或 HTTP API 使用参数化查询，不把输入参数伪装成返回列或 `WHERE` 字段。目录保留对象真实 `kind`，但无论 `kind` 是 `table`、`view`、`stored_procedure` 还是 `api_dataset`，返回列都使用统一扁平表结构：

HTTP API 连接器使用 Axios 调用受保护的数据源。连接器为每个数据源创建受控 Axios 实例，统一应用超时、请求拦截、响应拦截、错误转换和取消；响应拦截只处理连接器内部的原始 JSON。每张 HTTP API 虚拟表在 DAS 元数据 SQL Server 的 `api_dataset_response_mappings` 中配置固定 `request_method`、相对 `request_path`、受控参数位置映射、`response_mode`、`response_path` 和字段 JSONPath。`response_mode` 明确为 `list` 或 `object`：前者通过 `response_path` 定位结果数组并逐项映射，后者定位单个对象、映射一次并作为统一表的一行返回。请求方法、路径、参数映射和 JSONPath 都不是 API、Agent 或用户请求参数；DAS 不向 API 返回原始 JSON、JSONPath、接口地址或接口密钥。

`query_parameters` 是 Data 提供的基础输入定义。API 可以通过 `query_parameter_policies` 删除参数、缩小允许操作，并为省略的参数提供 `default_value`；没有请求值且没有默认值时，`required: true` 的参数必须拒绝执行。

API 调用 Data Access Service 时提交一个内部请求对象：`{ access, query, signature }`。API 完成对象、字段、关系、统计规则、参数和权限校验，将条件写入最终 DSL 中语义对应的位置；`signature` 覆盖 `access` 与 `query`。DAS 验签后将逻辑对象映射至本地白名单定义的物理对象，收紧行数、超时和并发限制。该对象只存在 API 与 Data Access Service 内部，不进入模型工具参数。

```json
{
  "type": "parameterized_query",
  "source_id": "clinical_reporting",
  "from": { "object_id": "clinical.admission_report", "alias": "r" },
  "parameters": [
    {
      "name": "admission_date_from",
      "data_type": "date",
      "value": "2026-01-01"
    },
    { "name": "admission_date_to", "data_type": "date", "value": "2026-01-31" }
  ],
  "limit": 100
}
```

`approved_relations` 中一条关系的多个 `column_pairs` 编译为 Join 的多个等值条件，并使用 `AND` 连接。同一对数据对象可以配置多条带业务描述的候选关系，模型只能选择 API 已批准的关系。

DSL 中的对象、字段、别名、聚合、操作符、Join 类型、过滤条件树、参数类型和最大行数都必须通过 Zod Schema 与 API 校验。模型提出业务筛选，API 依据指标口径、批准关系和权限生成最终条件结构，再提交可直接执行的 DSL。统一参数类型为 `string`、`integer`、`decimal`、`boolean`、`date`、`datetime`、`buffer`；日期和日期时间使用固定字符串格式，二进制在 JSON 中使用 Base64 文本。

## 6. Join 与权限条件

API 管理批准关系及其字段对、数据集粒度、唯一键与关联基数，并依据指标的去重、聚合和总计规则生成最终 DSL。多表关联可能放大业务记录时，API 先确定正确的聚合层次和关联方式，再签名提交。各指标的实际时间字段由所选口径唯一确定；不同日期依据对应不同指标定义。

API 按以下语义放置条件：

- 主对象的授权范围独立生效，限制参与查询的主记录。
- API 将各对象的授权范围写入 `from.filters` 或 `joins[].filters`，DAS 在对象参与关联前执行；LEFT/RIGHT JOIN 中没有授权匹配行的保留侧记录仍保留，可选侧字段为 `NULL`。关联后的业务筛选独立放在根 `query.filters`。
- 用户明确要求必须存在匹配记录时，API 按这一业务筛选语义生成查询。
- 查询级筛选放入 `query.filters`；每条条件引用本次查询的明确别名。

DAS 按最终 DSL 的位置和结构编译执行。实际 SQL 的物理对象、参数名和方言表达式由连接器映射生成，统计与授权语义保持一致。

共享 Schema 支持主对象和关联对象的递归预过滤及 `pre_aggregate`。DAS 在对象权限过滤后分组投影，再按批准字段对关联并执行最终聚合；最外层应用返回行数限制。API 维护唯一键、关联基数和字段来源，检查当前查询是否扩行及是否可能重复计算；DAS 按签名后的结构执行。最终排序可引用选择项的输出别名。当前分层结构为每对象预聚合加最终聚合，配置与示例见 [分层聚合说明](../ai-data/RELATIONAL-AGGREGATION.md)。指标版本、总计公式及带值 ON 按相应后续能力验收。

## 7. API 工具与内部调用

| 工具               | 作用                                                   | 权限行为                           |
| ------------------ | ------------------------------------------------------ | ---------------------------------- |
| `search_catalog`   | 按关键词检索当前数据源的对象、字段和注释。             | API 按当前用户权限筛选。           |
| `list_datasets`    | 分页列出授权对象。                                     | API 按当前用户权限筛选。           |
| `describe_dataset` | 返回一个对象的统一表结构、源注释、输入参数和查询能力。 | API 校验对象读取权限和字段可见性。 |
| `query_dataset`    | 执行 API 提交的关系查询或参数化查询 DSL。              | API 完成业务与权限校验后调用 DAS。 |

模型只调用 API 提供的工具，工具参数只包含业务查询 DSL。API 在转发时构建 `{ access, query, signature }` 并在请求头携带 `Authorization: Bearer <JWT>`；这些授权和签名字段不进入模型工具参数。当前内部调用使用 HTTP；JWT 识别调用方，`signature` 保护请求体完整性，但两者不加密查询结果。

## 8. API 与 Data Access Service 的调用顺序

```text
用户请求
-> API 完成认证、加载角色和原始权限策略
-> API 创建 analysis_run，加载原始权限策略
-> Codex Harness 根据 Skill、当前目录、指标知识和查询证据提出查询意图
-> API 完成关联、统计、参数和权限处理，生成最终可执行 DSL；写入审计和脱敏 access，计算 signature
-> Data Access Service 校验 JWT、signature 与完整内部请求
-> Data Access Service 根据 source_id 选择受保护数据源配置
-> 连接器验证、编译并执行只读请求
-> DAS 将执行或拒绝事件写入本地审计库
-> 返回表格、字段元数据、行数和新鲜度
-> API 向浏览器推送 SSE
```

## 8.1 服务心跳与数据源健康

Data Access Service 还必须按固定间隔向 API 发送 `dataAccessHeartbeatSchema` 心跳。心跳是 Data Access Service → API 的单向状态合同，不属于模型工具参数，也不通过 SSE 转发给浏览器。

- `service_id` 标识 Data Access Service 实例；`service_protocol` 和 `service_port` 是 DAS 从实际监听地址识别的协议与端口；`status` 表示该实例是否能够接收新的查询；`sent_at` 是发送方生成的心跳时间；`sources` 是各 `source_id` 的健康检查快照。API 以实际接收心跳连接的远端 IP、协议和端口生成内部调用地址。
- DAS 首次注册提交 API 签发的实例接入凭证。API 验签，核对实例启用状态和凭证版本后建立随机会话，并绑定连接来源、协议与端口。后续心跳携带会话凭据；API 校验绑定和有效期，更新健康记录。当前每 30 秒上报，成功心跳续期 90 秒。
- 会话超时或 API 重启后，实例退出调度。DAS 收到 HTTP 401 后重新读取接入凭证文件并注册；数据库中的历史健康记录只有匹配当前有效会话才能参与调度。接入凭证生命周期由 API 实例启用状态及凭证版本控制，配置变更在 API 重启后生效。
- 服务 `healthy` 不等于所有数据源 `healthy`。某个数据源为 `unhealthy` 时，API 只拒绝该 `source_id` 的查询；其他健康数据源仍可使用。`unknown` 表示尚未完成或暂时无法完成检查。
- 心跳正文包含状态、版本和安全诊断信息，认证使用 Authorization 请求头。当前会话状态保存在单个 API 进程内存中；配置、凭证文件和网络要求见 [服务接入说明](../ai-data/SERVICE-AUTH.md)。

目录的用户授权由 API 处理；DAS 目录接口读取本地对象暴露白名单。API 的目录和管理调用携带 60 秒 JWT，绑定目标实例、用途、HTTP 方法、路径及正文摘要；DAS 使用 API 公钥在业务处理前验签。API 的实例诊断及管理代理要求 `system_admin` 或 `data-access:manage`，接入凭证签发仅限系统管理员。

## 9. 数据源与密钥

Data Access Service 不持久化业务数据、用户会话、查询结果或 API 原始权限策略，但持久化自身的数据源配置与对象暴露白名单。`data_source_secrets` 保存可复用的数据库服务器地址、端口和登录凭据，或 HTTP API 地址与请求头；`data_source_configs` 为每个 `source_id` 保存目标数据库，Oracle 的目标值固定为从 CDB 发现并选择的 PDB Service Name，以及独立连接池、并发和查询限制。同一数据库服务器账号可以由多个数据源配置复用，各数据源仍建立独立连接池。接口地址或密钥只以 `secret_ref` 和受保护连接配置提供。

```text
source_id
secret_ref
capabilities
allowed_objects
row_limit
timeout_ms
connection_pool_limit
```

`allowed_objects` 是 DAS 本地维护的 API 对象暴露白名单。目录发现和查询必须通过该白名单；查询的业务授权由 API 在签名 DSL 中表达。业务数据库使用只读账号，HTTP API 使用受控的只读凭据、出口配置和静态响应映射。Data Access Service 不向 Agent、API 或浏览器返回连接串、服务器地址、接口密钥、密码、原始 SQL 或原始 HTTP JSON。

Oracle 的服务器凭据保存一次。管理员使用 CDB SID 或 Service Name 连接 CDB，DAS 读取可访问的 PDB 和对应 Service Name；Web 选择 PDB 后，DAS 把该 Service Name 保存为 `source_id` 的目标连接值，再发现该 PDB 下的对象。PDB 显示名不直接作为连接地址使用。

## 10. 审计与失败原则

内部查询在验签后建立可信访问上下文，认证与部署要求见 [服务接入说明](../ai-data/SERVICE-AUTH.md)。

每次查询由 DAS 写入自己的 SQL Server 审计库。服务器生成唯一请求标识，通过 `x-request-id` 响应头提供；错误体同时提供 `request_id`。审计中的 `analysis_run_id` 关联 API 分析运行：

```text
analysis_run_id
user_id
organization_id
policy_version
source_id
对象列表
查询 DSL 摘要
参数摘要
行数、耗时、拒绝原因
```

验签前的格式错误、缺少令牌和认证失败只记录服务器请求标识及固定拒绝分类；验签后的记录包含可信身份、逻辑对象、查询类型与参数名。摘要不包含参数值、JWT、签名、原始 SQL、连接配置或结果行。成功、拒绝、超时、失败各写一条最终事件；取消记为 `failed`，错误码为 `CANCELLED`。审计写入失败返回服务错误并停止交付结果，失败说明通过请求标识关联服务器日志。

每个数据源统一控制查询并发和排队：活动上限与等待容量均使用 `concurrency_limit`，队列满时返回明确的繁忙错误，调用方可重试。`timeout_ms` 覆盖进入连接器后的排队和执行；取消沿 API HTTP 请求、DAS 查询与驱动传播，已中断请求的晚到结果不再交付。中断后并发名额保留到驱动完成清理，数据源关闭时拒绝等待任务、取消在途任务并等待连接归还。

SQL Server 使用请求取消，MySQL 与 PostgreSQL 关闭本次借用连接，Oracle 使用调用超时与中断能力，HTTP 请求使用取消信号。驱动取消的真实数据库效果仍需部署环境验收。`row_limit` 控制单次响应数量，超过时明确标记 `truncated`；大批量完整明细的分页或导出作为后续查询交付能力。`cost_limit` 仅兼容历史配置，新配置可省略，不参与执行控制。

以下情况必须拒绝执行：

- 访问凭证无效、过期，或 `signature` 与请求体不匹配。
- JWT 的签名、签发方或接收方校验失败。
- 本地对象白名单或数据源配置不存在、已停用。
- DSL 结构不合法、无法编译或超出 DAS 的资源限制。
- SQL Server 请求不是只读 `SELECT` 语义，或其他连接器请求超出其只读能力。

## 11. 管理页面范围

管理页面属于 AI BI Web 的管理员端，不属于 Data Access Service。第一版提供：

- 数据源目录同步与对象列表。
- 配置数据源、共享服务器凭据和目标数据库。
- 浏览可访问目标数据库，展开表、视图和存储过程并维护对象白名单。
- Oracle 从 CDB 发现 PDB，并选择对应 PDB Service Name 作为目标连接。
- 数据源健康状态和当前统一目录的查看。
- 查询审计、拒绝原因与策略版本查看。

API 的权限管理页面与 DAS 数据源管理页面分别负责各自配置；数据源启停或更新时，DAS 关闭该 `source_id` 的运行时连接器，后续请求创建新实例。
