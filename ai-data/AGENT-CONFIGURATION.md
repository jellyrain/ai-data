# Agent 配置接口

第 8 步实现组织内的模型和 Agent 版本管理、工具选择、Skill 资源读取，以及会话固定版本运行。所有接口使用 API Access JWT，组织来自当前身份。Web 页面在后续阶段接入这些接口。

## 接口

| 接口                                         | 行为                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| `POST /models`                               | 发布模型新版本，返回 201 和公开配置                       |
| `GET /models`                                | `{ items: [...] }`，每个模型的最新版本                    |
| `GET /models/:id?version=1`                  | 指定版本；省略版本读取最新版本                            |
| `PATCH /models/:id/status`                   | `{ "enabled": false }`，成功返回 204                      |
| `POST /agents`                               | 发布 Agent 新版本，返回 201                               |
| `GET /agents`                                | `{ items: [...] }`，每个 Agent 的最新版本                 |
| `GET /agents/:id?version=1`                  | 指定或最新版本，包含当前 `enabled` 和 `skill_fingerprint` |
| `PATCH /agents/:id/status`                   | `{ "enabled": false }`，成功返回 204                      |
| `GET /agent-tools`                           | 已注册业务工具的 `name`、`description`                    |
| `GET /skills`                                | 公共源库的 `name`、`description`、完整资源 `fingerprint`  |
| `GET /skills/:id?path=references/example.md` | 读取 Markdown，省略 `path` 读取 `SKILL.md`                |
| `POST /conversations`                        | 可提交 `title`、`agent_id`、`agent_version`               |
| `GET /analysis-runs/:id`                     | 运行快照包含已绑定的 `agent_id`、`agent_version`          |

模型写操作需要 `system_admin` 角色或 `models:manage` 权限；Agent 写操作需要 `system_admin` 或 `agents:manage`。读取需已认证身份；模型和 Agent 按组织隔离，Skill 源库及工具目录由部署方统一维护。会话和运行仍按用户及组织隔离。

配置版本从 1 顺序递增。发布已存在版本或跳过版本返回 `409 CONFLICT`；查询不存在或其他组织的资源返回 `404 NOT_FOUND`。停用 Agent 阻止新会话选择及后续执行，返回 `403 UNAUTHORIZED`；停用模型在装配时返回 `400 INVALID_INPUT`。已经开始的轮次保留本次装配配置，取消使用既有运行取消接口。

## 发布模型

```json
{
  "model_id": "analysis-model",
  "version": 1,
  "name": "分析模型",
  "protocol": "responses",
  "base_url": "http://127.0.0.1:8000/v1",
  "model": "example-model",
  "context_window": 32768,
  "api_key": "example-only-key",
  "headers": { "X-Provider": "example" }
}
```

`api_key`、`headers`、`context_window` 可省略。每次发布提供该版本完整的认证配置，省略认证项表示本版本不用该项。公开响应包含 `has_api_key` 和 `header_names`。API 将凭据整体以 AES-256-GCM 加密，与模型版本在同一 SQL 事务中保存；`model_configuration_versions` 的 `key_id`、`encrypted_payload` 和 `encryption_metadata_json` 分别保存主密钥版本、二进制密文及随机 IV/认证标签。

API 与 DAS 复用 `@ai-data/metadata/secrets` 的加密器和本地主密钥库。API 主密钥位于 `state_directory/model-keys`，首次使用自动初始化，重启读取已有版本；DAS 继续使用自己的本地密钥目录。主密钥目录需由部署账号保护，并与 SQL 配套备份；Windows 权限由部署目录 ACL 管理。缺失/错误的主密钥或损坏的密文会使运行装配失败，接口和错误信息不返回凭据原文。

认证通过专用环境变量和官方 `env_key` / `env_http_headers` 使用。某模型版本首次执行时，如当前进程尚未装载其配置，先等待在途轮次结束，再重建 app-server 并继续执行。已装载的提供方可并发运行；等待中的请求支持取消。发布接口完成后，该版本在首次运行时装入进程。旧会话保留原模型版本及凭据。

## 发布 Agent

```json
{
  "agent_id": "outpatient",
  "version": 1,
  "name": "门诊分析",
  "description": "门诊统计与追问",
  "instructions": "依据当前授权目录和查询证据回答。",
  "model_id": "analysis-model",
  "model_version": 1,
  "tool_names": ["search_catalog", "describe_dataset", "query_dataset", "read_skill_reference"],
  "skill_names": ["query-dsl"],
  "limits": {
    "timeout_ms": 180000,
    "max_tool_calls": 30,
    "max_context_bytes": 65536
  }
}
```

`description`、`instructions` 默认空文本。`skill_names`、`tool_names` 可以为空数组；绑定 Skill 时需选择 `read_skill_reference`，便于读取配套说明。工具发现及执行都受选定清单限制。Agent 不能扩大当前用户的数据权限。

`timeout_ms` 为 1000–600000 毫秒，约束入场后一次 Harness 执行；新增提供方的等待阶段可由用户取消。`max_tool_calls` 为 1–100；`max_context_bytes` 为 4096–1048576 字节，限制本次业务消息和证据输入。`limits.context_window` 可选，覆盖模型配置中的上下文容量；上下文压缩继续使用官方默认逻辑。

## Skill 发布与会话绑定

部署方维护 `analysis_runtime.skills_directory` 指定的公共源库，相对路径以 API 启动目录解析；省略时使用随项目提供的 `packages/skills`。入口 frontmatter 的 `name` 与目录同名，`description` 使用单行文本，可使用普通文本或单/双引号。

发布 Agent 时复制每份 Skill 的完整目录，以内容摘要固定版本。布局为：

```text
state_directory/
├─ agents/<组织和 Agent 的 SHA-256>/versions/<版本>/.agents/skills/<名称>/
├─ model-keys/active-key.json      当前主密钥版本引用
├─ model-keys/keys/<版本>.key      AES 主密钥
├─ home/                         官方线程历史和状态
├─ logs/
└─ tmp/
```

同一 Agent 版本的会话共用资源目录，各自有独立官方线程。多个 Agent 引用同一 Skill 时分别保存副本。源库修改后发布新的 Agent 版本，新版本使用新资源；已建会话继续使用原快照。恢复时校验目录、名称和内容指纹，缺失或被改写时拒绝执行。资源不接受符号链接；读取接口只返回目录内 Markdown。

```json
{ "title": "九月门诊", "agent_id": "outpatient", "agent_version": 1 }
```

省略 `agent_version` 绑定当时最新版本；省略 `agent_id` 使用 `default`。会话响应沿用既有字段风格，新增 `agentId`、`agentVersion`。运行快照使用 `agent_id`、`agent_version`。配置更新后，已有会话的绑定保持不变。

API 启动后，尚未配置的组织返回空模型与 Agent 清单。管理员先发布模型，再发布 Agent；默认入口需要 `default` Agent，或在会话创建时指定其他 Agent。启用运行时后，选择尚未发布的 Agent 创建会话返回 `404 NOT_FOUND`。后续启动读取已有版本；更新通过管理接口发布新版本。完整首次配置示例见[部署说明](DEPLOYMENT.md#首次发布模型与-agent)。

升级前未绑定的会话在首次自动执行时绑定当前默认 Agent，当前运行同时记录版本；历史已完成运行保留原记录。首次装配后的配置摘要变化会建立新的官方线程，并加载已授权业务消息和证据；后续恢复沿用这个线程。结构化接口模式仍可创建未绑定会话。

配置、目录与模型认证、SQL 和官方线程状态需要配套保留。当前验收范围与已知模型行为见[测试说明](TESTING.md)和[第 8 步交付说明](../任务交接/第8步交付说明.md)。
