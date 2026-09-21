# 分析运行、指标和报告

API 实例通过一个常驻官方 app-server 管理多个业务线程，并将上下文压缩开始、完成状态持久化为 `context_compaction` SSE 事件。状态目录以项目启动工作目录为基准。压缩展示约定见[第 7 步说明](../任务交接/第7步常驻运行与状态推送.md)，Agent 装配和最新验证见[第 8 步交付说明](../任务交接/第8步交付说明.md)。

API 提供自动分析运行、结构化查询、指标口径、证据和报告接口。启动通过 `000_schema_migrations.sql` 与 `001_initial_api_schema.sql` 建立版本登记表和完整业务结构。管理员通过接口发布数据库中的模型与 Agent，会话固定 Agent 版本；模型认证加密保存，主密钥由服务端本地密钥库管理。元数据库连接、进程与调度参数使用本地 `apps/api/config/api.config.json`，空模型库可先启动登录再配置。接口见[Agent 配置接口](AGENT-CONFIGURATION.md)，运行与部署见[模型运行时配置](MODEL-RUNTIME.md)。

## 运行入口

请求携带 API Access JWT。先创建会话，再向 `POST /conversations/:id/messages` 提交：

```json
{ "content": "统计本月就诊人次", "idempotency_key": "message-001" }
```

消息、运行和 `analysis_dispatches` 调度记录在同一事务中保存。同会话最多存在一个活跃运行；同一键、相同正文返回原消息和运行，不同正文返回 `409 CONFLICT`。启用模型运行时后，事务提交唤醒调度器，后台认领该运行。不同会话在配置的并发预算内执行。

| 接口                              | 用途                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /analysis-runs/:id`          | 当前运行快照、租约代次、待答问题和证据标识                                            |
| `POST /analysis-runs/:id/queries` | 提交 `{ idempotency_key, query }`，执行一次结构化查询并保存证据、完成运行             |
| `GET /analysis-runs/:id/events`   | SSE 实时读取和断线回放；`Last-Event-ID` 为运行内整数序号                              |
| `GET /analysis-runs/:id/evidence` | 读取已授权的查询来源和结果快照                                                        |
| `GET /analysis-runs/:id/steps`    | 读取关联证据的分析步骤                                                                |
| `GET /analysis-runs/:id/tools`    | 启用运行时时读取工具调用、输入摘要、状态、耗时、失败码和证据关联                      |
| `POST /analysis-runs/:id/answers` | 提交 `{ clarification_id, idempotency_key, option_id }` 或 `custom_input`，续接原运行 |
| `POST /analysis-runs/:id/cancel`  | 持久化取消状态并中断当前执行                                                          |

`AnalysisRunService` 提供认领、续租、澄清和步骤保存能力。`AnalysisExecutor` 在一次租约内连续执行目录、指标、查询、澄清和报告工具，最终助手消息与完成事件一起提交；单个工具查询只提交证据和对应事件。直接查询及指标 HTTP 接口继续保留单次操作的完成语义。

租约默认 30 秒；自动执行器每 5 秒续租，直接查询期间每 10 秒续租。恢复执行器认领过期运行后递增代次，旧执行器不能提交结果或终态。取消中断本实例的模型和查询；其他实例在续租或提交时发现状态变化。查询和指标工具按规范化输入的稳定摘要复用已保存证据。

`request_clarification` 持久化问题、选项、助手消息和待答状态。回答成功保存用户消息并把同一运行重新置为待执行，事务提交后唤醒调度器。最终助手消息关联原运行；追问创建新运行，并在权限复查后恢复 SQL 中保存的官方线程。身份范围、策略、工具、模型或 Skill 变化时使用新线程和已授权上下文；保存映射时校验租约代次与有效期。

调度器在启动及周期扫描时发现 `created` 和租约过期的 `running` 任务，依据持久化登录会话引用重新读取身份与授权。会话失效时写入运行失败；每次工具执行和结果交付前仍重新校验当前身份、权限和租约。

状态、事件、证据、步骤和操作幂等记录由事务仓储一起提交。运行仅对所属用户和组织开放。SSE 使用已提交事件；断开连接结束读取，查询取消通过取消接口执行。

自动分析加载会话所绑定 Agent 的 Skill 快照：首轮提供 `SKILL.md` 入口，再通过 `read_skill_reference` 按需读取快照内 Markdown。发布 Agent 时固定完整资源，源文件更新后通过新版本用于新会话。默认 Agent 选择 `query-analysis` 和 `query-dsl`。业务工具从目录中选择，工具范围与用户数据权限共同约束执行。`GET /analysis-runs/:id` 返回已绑定的 `agent_id`、`agent_version`，历史未绑定记录省略这两个字段。

`describe_dataset` 返回已授权数据集、统计粒度 `grain`、可见字段构成的 `unique_keys`，以及目标对象和连接字段均可访问的 `approved_relations`。单个工具输出上限为 64 KiB。

## 指标口径

`POST /admin/metrics` 接收 `MetricDefinition` 并返回待审候选，需要系统管理员、`knowledge:manage` 或 `catalog:manage` 权限。候选经负责人审核后发布；`GET /metrics` 列出当前可访问且已生效的正式指标，`GET /metrics/:id?version=1` 读取指定版本。发布版本从 1 顺序增加且不可覆盖；更换时间依据或主来源时使用独立指标标识。审核、停用及回滚接口见[知识与记忆](MEMORY-KNOWLEDGE.md)。

定义包含统计粒度说明、去重键、固定日期字段、允许维度、聚合查询模板，以及取值列或分子分母。查询模板显式表达 `count_distinct`、预聚合等统计操作；发布时检查目录、字段和查询能力。

`POST /metrics/:id/execute` 示例：

```json
{
  "analysis_run_id": "由消息接口返回的运行标识",
  "version": 1,
  "idempotency_key": "metric-001",
  "start": "2026-09-01",
  "end": "2026-09-30",
  "dimensions": ["v.department"]
}
```

日期范围包含两端；`date` 使用 `YYYY-MM-DD`，`datetime` 使用东八区 `YYYY-MM-DD HH:mm:ss`。调用方只能选择已发布维度。总计在相同权限和时间范围独立执行，跨组去重重新计算，比率按总分子除以总分母，零分母或空聚合返回 `null`。分组结果保留 `truncated` 标记。省略版本时首次读取最新版，已有证据的同键重试固定原版本。

响应包含指标版本、分组查询结果、逐行指标值、总计值和两份证据标识。

## 证据和报告

`POST /reports` 接受共享 `SaveReportInput`：运行标识、标题、章节、报告块和 `shared_with` 用户标识。文本、表格和图表块均引用当前运行的证据；图表坐标必须存在于证据列，纵轴为数值列。API 填充组织、作者、版本和完整来源快照；共享工具 `saveReportToolInputSchema` / `saveReportToolOutputSchema` 对应同一入口。

`GET /reports/:id?version=1` 读取版本。`PUT /reports/:id` 接受 `{ expected_version, report }`，仅作者可更新；并发旧版本提交返回 409。分享范围由最新版本决定，收回分享同时作用于历史版本。

运行工具 `save_report` 使用当前运行、工具输入摘要生成确定性报告标识，保存事务校验执行租约，重复调用返回同一报告。工具生成的报告初始为个人快照。

读取报告同时检查分享权限及每份来源的当前查询授权。历史证据的授权查询和输出脱敏规则必须与当前重新计算的结果一致；无法确认完整来源范围时返回 `POLICY_REJECTED`，调用方重新查询生成新快照。长查询在执行前、结果保存前和运行完成前重新读取身份权限。

运行证据容量为 5,000 行/2 MiB，SSE 表格最多返回 100 行/256 KiB 样本。模型查询结果最多返回 100 行，并按 32 KiB 样本预算装入数据，保留原始行数、`delivery`、`sampled` 和证据关联。普通 `POST /query` 的有界完整结果合同见[结果交付设计](../需求文档/result-delivery-and-export.md)。

## 目录策略管理

目录管理接口要求 `system_admin` 或 `catalog:manage`，并校验目标角色属于当前组织。对象、字段和行条件引用按当前 DAS 目录检查。已有三个写入接口接受可选 `expected_version`，成功返回 `204`，并在 `x-policy-version` 中返回已提交版本：

- `PUT /admin/catalog/object-permissions`
- `PUT /admin/catalog/column-permissions`
- `PUT /admin/catalog/row-policies`

版本号在同一组织、同一数据源内递增。每个不可变版本保存目标角色在该源的完整策略快照、单次变更、发布人和发布时间。`expected_version` 比较目标角色当前版本，`0` 表示首次发布；不一致返回 `409 CONFLICT`。策略写入、版本快照和审计同事务提交。

| 接口                                                            | 用途                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /admin/catalog/policy-versions/:sourceId/:roleId`          | 按版本倒序读取摘要；`limit` 默认 20、最多 100，`before_version` 为游标  |
| `GET /admin/catalog/policy-versions/:sourceId/:roleId/current`  | 读取该角色当前版本及完整快照                                            |
| `GET /admin/catalog/policy-versions/:sourceId/:roleId/:version` | 读取指定历史版本                                                        |
| `POST /admin/catalog/query-preview`                             | 提交 `{ role_id, query }`，返回按该角色计算的最终 DSL 和 `output_masks` |

预览加载指定角色自身的授权资料，复用 `QueryAuthorizationService` 完成对象、字段、关联、行范围和脱敏计算。依赖具体业务用户的策略须通过该用户实际查询验收；预览返回稳定的授权拒绝原因。预览计算授权结果，业务数据执行由查询接口承担。

## 部门范围

管理员通过 `PUT /admin/users/:id/departments` 提交 `{ "department_ids": ["A", "B"] }`。范围写入 `user_department_scopes`，与授权版本一起更新，并清除当前实例的用户身份缓存。空数组收回部门范围。行策略通过 `permission_context.department_ids` 引用该集合；相关策略在范围为空时拒绝执行。

## 验收范围

[API 集成测试](apps/api/tests/integration/analysis.integration.ts)验证真实元数据库事务、并发幂等、恢复、部门授权、指标版本和报告快照；业务样本使用真实 SQL Server 就诊表和真实 API 目录授权，查询客户端使用只接受样本聚合模板的 SQL 适配器。[DAS 集成测试](apps/data-access/tests/integration/sqlserver.integration.ts)独立验证真实 DAS 驱动、编译器、存储过程、类型、审计、超时和取消。

本轮官方 Harness 验收结果见[测试说明](TESTING.md)。API 集成包含策略并发版本和报告保存的原子去重、取消拒绝保存。

[对话集成测试](apps/api/tests/integration/dialogue.integration.ts)的 3 项确定性场景通过，以脚本化模型 Harness 调用 API HTTP 路由、DAS HTTP、JWT、编译器和 SQL Server，覆盖澄清续接、证据重试复用、追问、两角色授权及会话和事件归属。

实际模型验收使用项目内官方 Codex app-server：使用配置的模型、两份生产 Skill 和运行工具，DAS 以 `node` 直接运行实际构建产物；模型完成目录核对、日期过滤、去重计数、最终答案及证据审计，受限角色只取得 A 科室 2 人次，并验证重启后恢复官方线程回答追问。第 7 步后端验收已完成，复跑入口见[测试说明](TESTING.md#对话链路验收)。Web 交互按[开发清单](../需求文档/development-checklist.md)实施。
