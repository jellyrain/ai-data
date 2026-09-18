# 模型运行时配置与部署

Node API 通过项目依赖中的官方 Codex app-server 运行 Codex Harness。`CodexAnalysisHarness` 负责进程与协议适配；官方运行时负责模型轮次、工具调用、Skill 和线程历史。`AnalysisExecutor` 负责身份、租约、证据和终态，`PollingAnalysisDispatcher` 从 SQL 调度任务。业务接口见[分析运行说明](ANALYSIS-RUNTIME.md)。

## 依赖与部署文件

当前 API 声明 `@openai/codex-sdk@0.154.0`。代码先解析 SDK 的 ESM 入口，再从其依赖位置定位 `@openai/codex@0.154.0` 及对应平台的原生程序，启动 `app-server`。普通函数接入使用 app-server 的 `dynamicTools`。依赖安装与调整由用户操作。

部署保留 API 的 `dist`、`migrations`、本地 `config`、生产 `node_modules` 中的 Codex 运行时及目标平台可选依赖，以及 `packages/skills/query-analysis/` 和 `packages/skills/query-dsl/` 的完整目录结构（含 `SKILL.md` 与子文档）。原生程序不包含在 JavaScript bundle 中。部署按锁文件安装依赖，并为部署操作系统保留对应平台包。

API 构建目标为 Node.js 24，工作区要求 `>=24.19.0 <25`；正式入口为 `node dist/index.js`。启动自动执行元数据库迁移；新增 `007_codex_threads` 保存业务会话对应的官方线程标识及上下文摘要。

## 本地配置

API 默认读取 `apps/api/config/api.config.json`，也可通过 `API_CONFIG_PATH` 指定。模型标识与地址由部署方填写：

```json
{
  "analysis_runtime": {
    "enabled": true,
    "active_provider": "local-model",
    "providers": [
      {
        "id": "local-model",
        "protocol": "responses",
        "base_url": "http://127.0.0.1:8000/v1",
        "model": "example-model",
        "api_key": "replace-with-provider-key",
        "headers": {}
      }
    ],
    "state_directory": "secrets/codex-runtime",
    "context_window": 32768,
    "timeout_ms": 180000,
    "max_context_bytes": 65536,
    "max_tool_calls": 30,
    "concurrency": 2,
    "poll_ms": 1000
  }
}
```

`providers` 支持 1–20 个唯一标识的提供方，`active_provider` 选择当前条目。服务须支持 Responses 流式响应、普通函数工具及工具结果续接；仅支持 Chat Completions 的服务需先验证兼容性。配置在 API 启动时读取，切换后重启生效。认证密钥与自定义请求头通过子进程专用环境变量传递。

省略 `analysis_runtime` 或设置 `enabled: false` 时只启用结构化业务接口。

| 配置                | 默认值                  | 作用                                                   |
| ------------------- | ----------------------- | ------------------------------------------------------ |
| `state_directory`   | `secrets/codex-runtime` | 相对项目启动工作目录解析，保存官方历史、日志和临时文件 |
| `context_window`    | 官方模型配置            | 4096–2097152 token，填写所选服务实际支持的上下文容量   |
| `timeout_ms`        | 180000                  | 1000–600000 ms，一次 Harness 执行总时限                |
| `max_context_bytes` | 65536                   | 4096–1048576 字节，本次提交的业务消息与证据输入上限    |
| `max_tool_calls`    | 30                      | 1–100，单次执行器调用的工具次数上限                    |
| `concurrency`       | 2                       | 1–20，当前 API 实例的并发运行数                        |
| `poll_ms`           | 1000                    | 100–30000 ms，SQL 待执行任务扫描间隔                   |

提供方请求和流重试设为 0。超时、工具次数或输入容量超限时保存失败状态；最终助手文本上限为 64000 字符。`max_context_bytes` 不包含官方恢复的完整线程历史，该历史由 Harness 管理。旧配置的 `max_steps`、`max_output_tokens` 已移除，当前适配器没有逐次生成的输出 token 配额开关。

## 函数调用与会话恢复

API 使用 stdio 与项目原生进程通信。`initialize` 开启实验性协议，`thread/start.dynamicTools` 注册普通函数，`item/tool/call` 调回 Node 业务函数，再将结果交给 Harness 继续分析。两份 Skill 以 `turn/start` 的 Skill 输入加载。`dynamicTools` 为当前版本的实验性接口，升级后需重跑协议与实际模型验收。

API 启动时固定已加载 Skill 的完整目录快照，复制到 `state_directory/home/skills`。模型先读取 `SKILL.md` 入口，再按索引调用 `read_skill_reference` 获取需要的 Markdown 子文档。该函数只查询本次加载的资源快照，参数为 `skill_name` 和相对 Skill 目录的 `relative_path`。整份快照（包括子文档）参与线程版本判断；文件修改在重启 API 后生效。

API 启动时初始化一个常驻 app-server，然后启动 SQL 任务派发。不同会话分别使用官方线程，API 按线程、轮次和业务租约路由调用与事件。官方 `CODEX_HOME` 统一为 `state_directory/home`；各业务会话的工作目录为 `state_directory/work/<会话授权摘要>`。跨线程记忆的生成和使用关闭，业务权限由 API 校验。

相对路径以 `process.cwd()` 为基准。例如在 `apps/api` 下启动，默认根目录为 `apps/api/secrets/codex-runtime`；在工作区根目录执行 API 构建入口，则为工作区的 `secrets/codex-runtime`。`home` 保存历史、Skill 和状态，`logs` 保存官方日志，`tmp` 用于子进程的 `TEMP`、`TMP`、`TMPDIR`。重启部署应保持启动目录与配置一致。该目录包含对话和证据样本，应持久化并仅供 API 服务账号访问。

SQL 映射和官方历史共同支持重启恢复。多实例恢复要求目标实例能够访问相应状态；当前方案按单 API 实例管理一个进程。

恢复前复查会话内全部历史证据权限。身份范围、目录策略版本、模型提供方、工具定义、指令或 Skill 内容变化时，新建官方线程；保存映射时在 SQL 事务中检查当前租约代次和有效期。结果交付前再次复核授权。取消、超时和澄清暂停仅中断对应轮次；API 关闭时先释放执行，再关闭进程。未确认结束的轮次仍占用对应线程，避免重叠执行。

官方进程意外退出时，受影响的执行失败；后续请求合并为一次进程重建。失败的业务运行不会自动重跑，下一次执行仍需正常认领任务并复核权限。

## 上下文压缩事件

压缩沿用官方默认触发逻辑。API 消费 `contextCompaction` 条目的 `item/started` 与 `item/completed`，以 `context_compaction` SSE 事件持久化并推送。载荷包含 `item_id`、`status`（`started` / `completed`）、东八区 `occurred_at` 和公共运行关联字段。写入校验有效租约，事件按运行内序号回放。前台在压缩开始时显示提示，完成、运行终止、澄清等待或租约切换时结束对应提示。完整展示约定见[交付说明](../任务交接/第7步常驻运行与状态推送.md)。

## 工具执行与结果

运行时注册以下工具：

| 工具                                                  | 作用                                     |
| ----------------------------------------------------- | ---------------------------------------- |
| `read_skill_reference`                                | 按需读取已加载 Skill 的 Markdown 子文档  |
| `list_sources`                                        | 发现当前用户可查询的健康数据源           |
| `search_catalog`、`list_datasets`、`describe_dataset` | 搜索、分页探索和读取已授权目录及业务配置 |
| `list_metrics`、`describe_metric`、`query_metric`     | 读取固定口径与版本，执行分组和独立总计   |
| `query_dataset`                                       | 执行授权后的 DSL，保存并返回查询证据     |
| `request_clarification`                               | 保存问题和选项，暂停运行等待回答         |
| `save_report`                                         | 以当前运行证据保存个人报告快照           |

工具参数表达业务条件，身份、运行和租约由执行器绑定。每次调用及结果交付前重新读取会话和权限，并校验有效租约。一次运行中的多次工具查询共用租约，完成最终助手消息后由执行器提交运行终态。模型同轮发出的工具调用按顺序执行，澄清落库后暂停后续调用。

`describe_dataset` 返回 `dataset`、`grain`、当前可见字段组成的 `unique_keys`，以及目标对象和连接字段均可访问的 `approved_relations`。单个工具输出上限为 64 KiB，模型可通过搜索、分页或缩小查询条件继续探索。

模型工具 Schema 通过统一兼容发布层提供结构与说明；较大的字符串长度上限以描述形式传给模型。查询 `value` 明确发布为 JSON 标量或标量数组：`eq/neq` 使用单值，`in/not_in` 使用非空数组，`between` 使用 `[起始值, 结束值]`，`is_null/not_null` 省略 `value`。API 工具入口按完整 Zod 合同验证字段、类型组合、长度和业务限制，失败反馈包含字段路径及校验原因。

查询与指标工具使用工具名及规范化输入的稳定摘要关联已提交证据，重试复用该证据；审计另记录每次执行代次、调用、输入摘要、状态、耗时和证据引用。报告工具使用确定性报告标识，并在保存事务内校验当前租约。

模型查询结果最多选取 100 行，在 32 KiB 样本预算内装入数据，并保留原结果行数、完整性和证据标识；`sampled` 表示是否只返回部分行。运行证据和 SSE 的预算分别见[分析运行说明](ANALYSIS-RUNTIME.md)，三个交付用途各自保留完整性信息。

## 验收入口

协议单元测试使用真实 Node 子进程夹具；SQL 集成验证线程映射和租约；本地模型验收验证 API → DAS → 隔离 SQL 查询及重启后的官方线程续接。最新结果见[测试说明](TESTING.md)。
