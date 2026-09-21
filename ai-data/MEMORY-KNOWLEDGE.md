# 账号记忆、知识审核与后台任务

账号记忆按组织和用户保存，同一账号的会话及 Agent 共用。企业知识经过候选、负责人审核、发布后使用。数据结构归入 API `001_initial_api_schema.sql`，接口使用 API Access JWT。

## 个人偏好

| 接口                                    | 行为                       |
| --------------------------------------- | -------------------------- |
| `GET /me/preferences`                   | 当前有权读取的个人设置     |
| `GET /me/preferences/:key`              | 单个设置及版本             |
| `GET /me/preferences/confirmations`     | 仍有效的待确认项           |
| `PUT /me/preferences/:key`              | 当前用户主动保存设置       |
| `PATCH /me/preferences/:key/auto-apply` | 设置自动应用开关           |
| `DELETE /me/preferences/:key`           | 删除设置并保存最小版本标记 |

保存示例：

```json
{
  "idempotency_key": "save-period-1",
  "expected_version": 0,
  "scope": {},
  "value": {
    "type": "time_range",
    "range": { "type": "relative", "period": "this_year", "extent": "full_period" }
  },
  "auto_apply": true
}
```

支持 `metric`、`time_range`、`filters`、`grouping`、`presentation`、`query_habit`。字段条件限定数据源/对象或指标范围，并用当前目录和查询授权复核。管理接口修改属于用户明确操作；一般工具保存直接生效，发生值冲突或恢复停用设置时生成确认记录。API 从当前真实用户消息识别直接设置句，模型输入不能声明自己已经取得确认。

确认复用运行的 `POST /analysis-runs/:id/answers`，选项为 `approve`、`reject`；确认内容、账号和预期版本由服务端绑定。偏好变更、运行恢复和回答幂等记录在同一事务提交。后台留下的待确认项通过 `save_user_preference` 携带原 `confirmation_id` 进入对话；拒绝后该记录不再出现在待确认清单。

自动观察当前支持简单关系查询的 AND 条件、分组及匹配的日历范围，保存本轮查询证据。相同业务场景使用稳定键；重复来源不重复计数，观察达到两次后作为默认习惯提供。临时条件不覆盖已有默认；冲突保留为待确认项，停用开关在后续观察中保留。

相对时间支持本年、本季、本月、去年和上月；`full_period` 表示完整周期，`to_date` 表示截至当前日期。解析使用东八区，固定起止日期保持原值。分析上下文中的 `resolved_time_range` 给出本轮实际日期，`analysis_memory_contexts` 保存所用偏好/知识版本和解析结果。

## 企业知识

| 接口                                                         | 行为                               |
| ------------------------------------------------------------ | ---------------------------------- |
| `POST /knowledge-candidates`                                 | 提交指标或业务规则候选             |
| `GET /knowledge-candidates`、`GET /knowledge-candidates/:id` | 读取可访问候选                     |
| `PUT /knowledge-candidates/:id`                              | 修改内容，形成新候选版本并重新待审 |
| `POST /knowledge-candidates/:id/withdraw`                    | 撤回未发布候选                     |
| `POST/GET /knowledge-candidates/:id/sources`                 | 添加/读取来源支持                  |
| `GET /admin/knowledge-candidates`                            | 管理者或负责人查看待办             |
| `POST /admin/knowledge-candidates/:id/owner`                 | 分配有效负责人                     |
| `POST /admin/knowledge-candidates/:id/review`                | 审核固定候选版本                   |
| `GET /admin/knowledge-candidates/:id/reviews`                | 审核历史                           |
| `POST /admin/knowledge-candidates/:id/publish`               | 发布正式版本及生效时间             |
| `GET /knowledge`、`GET /knowledge/:id?version=1`             | 当前可用知识及历史版本             |
| `GET /admin/knowledge/:id/versions`                          | 版本历史                           |
| `PUT /admin/knowledge/:id/enabled`                           | 启停正式知识                       |
| `POST /admin/knowledge/:id/rollback`                         | 引用历史内容发布新版本             |

候选输入包含 `idempotency_key`、可选 `knowledge_id`、`content`、`scope` 和可选 `source`。业务规则内容为 `{type:"business_rule",title,body}`；指标内容为 `{type:"metric",definition}`。负责人分配和审核需要 `expected_version`；审核提交 `decision: approve|reject` 与 `comment`；发布提交 `expected_version` 和东八区 `effective_at`。

普通用户提交及查看自己的候选，负责人处理分配给自己的候选；系统管理员可代审，`knowledge:manage` 提供知识管理能力。修改内容后，旧审核不能发布新内容。候选按组织、类型、内容和范围去重；相同内容追加来源，每项最多 200 条支持。

提交时验证来源归属。读取共享候选或正式规则时，先校验候选身份/负责人或正式知识范围，再验证来源引用及全部关联证据的当前权限。会话引用仅返回标识，消息正文继续使用原会话权限。对话候选由服务端绑定本轮查询证据；追加来源不能扩大原始内容的可见范围。

`POST /admin/metrics` 仍接收 `MetricDefinition`，现在返回待审候选。正式指标写入与知识发布共用事务；`GET /metrics`、详情及执行只选择启用且已生效的发布版本。回滚发布新版本，更换固定时间依据或主来源仍需新的指标 ID。

## 工具与运行

新增工具为 `get_user_preferences`、`save_user_preference`、`get_published_knowledge`、`create_knowledge_candidate`。可通过新 Agent 配置版本选择；会话绑定的旧 Agent 工具清单保持固定。

每轮装配当前可访问的正式知识、个人默认及待确认项，并将内容/版本纳入官方线程的上下文摘要。本次明确条件和会话确认优先于个人默认，企业固定口径由指标服务执行。每轮最多装配 30 个偏好、30 项正式知识及 5 项待确认，完整输入仍受 Agent 的上下文容量限制。

## 后台任务

个人工具保存同步提交。查询习惯和企业候选意图先保存在当前运行，只有分析成功完成时才在完成事务中写入 `memory_events`。后台处理使用当前身份和来源，领域副作用与任务 `done` 状态同事务提交。

`memory_tasks` 可选配置：

```json
{
  "enabled": true,
  "concurrency": 1,
  "poll_ms": 2000,
  "timeout_ms": 10000,
  "lease_ms": 30000,
  "max_attempts": 3
}
```

前台繁忙时暂停领取新任务，后台容量独立。领取增加租约代次，过期后可由另一实例接管；旧代次提交被拒绝。失败按指数退避重试，关闭时释放任务；执行超时或关闭会使事务回滚。事务授权读取采用串行执行器，兼容 SQL Server 单事务连接。

`GET /admin/memory-events?limit=50` 返回本组织任务状态和稳定错误码；`POST /admin/memory-events/:id/retry` 重新派发失败任务。管理入口需要系统管理员或 `knowledge:manage`，返回数据不含个人意图正文。当前后台处理使用结构化数据和规则，不调用模型。

流程、验证和开发库基线说明见[第 10 步交付](../任务交接/第10步交付说明.md)。
