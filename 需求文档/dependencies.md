# AI BI 依赖清单

版本：v0.1  
状态：MVP 技术基线  
关联文档：[requirements.md](./requirements.md) · [technical-design.md](./technical-design.md)

## 1. 采用原则

- 采用 Node.js 与 TypeScript；前端遵从公司现有 Vue 3 技术栈。
- 每个包只能解决清晰的一类问题；不因“以后可能需要”提前引入运行组件。
- npm 依赖的解析版本由 `pnpm-lock.yaml` 固定，升级后完成相应兼容性验收。
- 模型运行时使用 Node.js 内的 `AnalysisHarness` 接口，由项目官方 Codex app-server 调用配置的 Responses 模型服务；模型配置和工具执行预算由 API 管理。

## 2. Web 前端

| 依赖                  | 用途                                                         | MVP | 备注                                       |
| --------------------- | ------------------------------------------------------------ | --- | ------------------------------------------ |
| `vue`                 | Vue 3 的运行时与组件响应式系统。                             | 是  | 公司技术栈。                               |
| `vite`                | 本地开发服务器与生产构建。                                   | 是  | 构建产物为静态文件，由 Caddy 托管。        |
| `@vitejs/plugin-vue`  | 让 Vite 编译 `.vue` 单文件组件。                             | 是  | Vite 的 Vue 编译插件。                     |
| `typescript`          | 前端、API、Data Access Service 的统一类型系统与编译器。      | 是  | 根工作区统一配置。                         |
| `vue-router`          | 对话、报告、管理等前端路由。                                 | 是  | 浏览器端路由。                             |
| `pinia`               | 跨组件、跨页面的 UI 状态，例如当前组织、侧栏和短暂交互状态。 | 是  | 不存放可由服务端重取的分析结果。           |
| `@tanstack/vue-query` | API 读取、缓存、失效与加载错误状态管理。                     | 是  | SSE 流本身不通过它缓存。                   |
| `echarts`             | 分析结果的柱状、折线、饼图、漏斗等图表渲染。                 | 是  | 图表配置由受控分析结果转换而来。           |
| `vue-echarts`         | ECharts 的 Vue 组件封装与生命周期集成。                      | 是  | 避免手写图表实例销毁与尺寸监听。           |
| `lucide-vue-next`     | 操作按钮和导航使用的标准图标组件。                           | 是  | 不以文字模拟常见图标操作。                 |
| `zod`                 | 前端校验 API、SSE 事件与表单输入的运行时结构。               | 是  | 与 API、Data Access Service 共用合同定义。 |

## 3. 共享合同与领域包

| 依赖  | 用途                                                            | MVP | 备注                                           |
| ----- | --------------------------------------------------------------- | --- | ---------------------------------------------- |
| `zod` | 定义查询 DSL、SSE 事件、API 工具输入输出及持久化边界的 Schema。 | 是  | 由 `packages/contracts` 导出类型与运行时校验。 |

`zod` 在工作区只安装一次；上表分别说明其在前端与共享合同中的责任，并不代表安装两份包。

## 4. AI BI API / Agent Gateway

| 依赖                        | 用途                                                          | MVP | 备注                                                                      |
| --------------------------- | ------------------------------------------------------------- | --- | ------------------------------------------------------------------------- |
| `fastify`                   | HTTP API、SSE 输出、路由、请求生命周期与插件体系。            | 是  | 不使用 Koa；Fastify 的类型、性能和插件边界更适合此服务。                  |
| `@fastify/cors`             | 限制浏览器跨域访问 API 的来源。                               | 是  | 生产环境只允许实际 Web 域名。                                             |
| `@fastify/helmet`           | 设置常见安全响应头。                                          | 是  | 与当前 HTTP 部署配置保持一致。                                            |
| `@fastify/rate-limit`       | 限制登录、对话和高成本分析请求频率。                          | 是  | 第一版可使用进程内存储；多副本后改为共享存储。                            |
| `fastify-type-provider-zod` | 将 Zod Schema 接入 Fastify 路由的输入、输出和类型推导。       | 是  | 避免 API 合同漂移。                                                       |
| `pino`                      | 结构化应用日志。                                              | 是  | 记录请求、分析运行、错误和审计关联 ID；不记录敏感原始数据。               |
| `jose`                      | 使用 JWT/JWS 签发 API 到 Data Access Service 的短时访问令牌。 | 是  | API 持有私钥，Data Access Service 仅持有公钥；JWT 不由 Agent 或前端构造。 |
| `prisma`                    | SQL Server 元数据数据库的迁移、Schema 定义与客户端生成。      | 是  | 仅服务 `ai_bi_meta`，绝不连接业务数据源。                                 |
| `@prisma/client`            | API 在运行时访问 Prisma 生成的元数据客户端。                  | 是  | 与 `prisma` 配套。                                                        |
| `@openai/codex`             | 提供官方 Harness 与 app-server 原生运行时。                   | 是  | 当前验证 0.154.0；Node API 通过 stdio 注册普通函数并处理回调。            |

## 5. Data Access Service

| 依赖                 | 用途                                                           | MVP | 备注                                                              |
| -------------------- | -------------------------------------------------------------- | --- | ----------------------------------------------------------------- |
| `@ai-data/contracts` | 复用 API 与 DAS 共享的 DSL、访问上下文、结果、错误和心跳合同。 | 是  | 使用 workspace 协议，不引用 contracts 的内部源码路径。            |
| `fastify`            | 提供 DAS 内部 HTTP 服务、健康检查和受控查询入口。              | 是  | 仅接受 API 内部调用，不面向浏览器。                               |
| `mssql`              | SQL Server 元数据和业务数据源的连接池与参数化查询。            | 是  | 只使用只读账号访问业务数据源。                                    |
| `oracledb`           | Oracle 数据源连接器。                                          | 是  | 安装脚本须经 pnpm 批准；只使用只读账号。                          |
| `mysql2`             | MySQL 数据源连接器。                                           | 是  | 使用参数化查询和只读账号。                                        |
| `pg`                 | PostgreSQL 数据源连接器。                                      | 是  | 使用参数化查询和只读账号。                                        |
| `axios`              | HTTP API 数据源连接器的受控客户端。                            | 是  | 为每个数据源创建实例，统一超时、拦截、错误转换和取消。            |
| `jsonpath-plus`      | 按已审核映射从 HTTP API 响应中提取行和字段。                   | 是  | 仅由 DAS 元数据配置使用，不能作为 API 或 Agent 的自由表达式执行。 |
| `jose`               | 验证 API 私钥签发的 JWT access token。                         | 是  | 校验签名、签发方、接收方与有效期后才执行内部请求。                |
| `p-limit`            | 限制单数据源或单租户的并发查询。                               | 是  | 防止分析查询耗尽连接池。                                          |
| `pino`               | 输出结构化查询审计和运行日志。                                 | 是  | 审计中保存 DSL 和结果摘要，不保存不必要明细。                     |
| `zod`                | 校验 DAS 配置、内部请求、DSL 与连接器配置结构。                | 是  | 校验失败时拒绝执行。                                              |

Data Access Service 通过内部适配层访问 SQL Server、Oracle、MySQL、PostgreSQL 和 HTTP API 等不同数据源。HTTP API 数据源使用 Axios 处理超时、拦截、错误转换和取消，使用 `jsonpath-plus` 按 DAS 元数据中的静态响应映射生成统一扁平 Dataset；`node:crypto` 提供签名和凭据加密基础能力。模型不直连该服务，目录与查询工具均由 API 提供。

## 6. 开发、质量与包管理

| 依赖                | 用途                                                   | MVP | 备注                                        |
| ------------------- | ------------------------------------------------------ | --- | ------------------------------------------- |
| `pnpm`              | 管理 Monorepo 依赖、工作区链接和锁文件。               | 是  | 所有应用共享一份锁文件。                    |
| `tsx`               | 本地直接运行 TypeScript 脚本、迁移辅助脚本与开发入口。 | 是  | 生产环境运行构建后的 JavaScript。           |
| `vue-tsc`           | 检查 Vue SFC 模板和 TypeScript 类型。                  | 是  | CI 必跑。                                   |
| `@types/node`       | Node.js API 的 TypeScript 类型声明。                   | 是  | API、Data Access Service 与脚本所需。       |
| `@types/pg`         | PostgreSQL 驱动的 TypeScript 类型声明。                | 是  | DAS 使用 `pg` 连接器时所需。                |
| `vitest`            | 单元测试与模块级集成测试。                             | 是  | 覆盖 DSL 校验、权限和领域规则。             |
| `playwright`        | 浏览器端到端测试。                                     | 是  | 覆盖登录后的对话、SSE、澄清与报告展示闭环。 |
| `eslint`            | 静态代码质量检查框架。                                 | 是  | 根工作区统一执行。                          |
| `eslint-plugin-vue` | Vue SFC 的 ESLint 规则。                               | 是  | 检查模板与 Vue 编码错误。                   |
| `typescript-eslint` | TypeScript 的 ESLint 解析器与规则。                    | 是  | 适用于前端、API 和 Data Access Service。    |
| `prettier`          | 统一代码格式。                                         | 是  | 只处理格式，不替代 ESLint。                 |

## 7. 基础设施与运行时

| 组件          | 用途                                                                    | MVP    | 备注                                                                         |
| ------------- | ----------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| SQL Server    | 存放 `ai_bi_meta` 元数据、会话、审计、任务和业务知识。                  | 是     | 与业务 SQL Server 使用不同账号和权限边界。                                   |
| Caddy         | 托管 Vue 静态文件、反向代理 `/api`、透传 SSE。                          | 是     | 当前按 HTTP 部署；若甲方已有成熟 Linux Nginx 体系，可改用 Nginx。            |
| WinSW 或 NSSM | Windows 裸机将 API、Data Access Service 注册为 Windows 服务并支持重启。 | 按环境 | 二选一，不与 PM2 叠加。                                                      |
| systemd       | Linux 裸机守护 API、Data Access Service 和相关进程。                    | 按环境 | 由操作系统负责重启与日志。                                                   |
| Docker        | 容器化部署与运行环境一致性。                                            | 否     | 可选，不作为 Windows Server 2012 交付前提。                                  |
| PM2           | Node 裸机进程守护和可选的单机 cluster。                                 | 否     | 仅在运维团队明确要求时使用，不能与 WinSW、NSSM、systemd 或 Docker 重复叠加。 |

## 8. MVP 明确不引入

| 组件       | 当前不引入的原因                                                        | 何时再评估                                           |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| Redis      | 第一版状态、任务与幂等性可由 SQL Server 实现。                          | 多 API 副本需要共享限流、缓存或协调时。              |
| Kafka      | 第一版没有高吞吐事件流需求。                                            | 出现大量异步学习、审计或外部数据事件时。             |
| BullMQ     | 它依赖 Redis，而 MVP 不部署 Redis。                                     | 引入 Redis 且后台任务量确实增长时。                  |
| 向量数据库 | 企业口径应以版本化结构化定义为准，不能以相似度静默覆盖。                | 文档型知识检索规模、召回质量和人工验证机制都成熟后。 |
| LangChain  | API 执行器、官方 Codex Harness 与持久化运行状态承担当前分析和工具协作。 | 具体业务能力需要额外框架且边界已验证时。             |
| LangGraph  | 第一版的工作流可由 Skills、受控工具和持久化 `analysis_run` 表达。       | 确认需要复杂、可视化、长生命周期图工作流时。         |

## 9. 版本与部署合同

- Node.js：工作区 `engines` 要求 `>=24.19.0 <25`，API 与 DAS 的构建目标为 Node.js 24，正式入口为 `node dist/index.js`。
- pnpm：工作区 `packageManager` 为 `pnpm@11.22.0`，已解析依赖版本由 `pnpm-lock.yaml` 记录。
- 模型运行时：API 声明 `@openai/codex-sdk@0.154.0`，代码从其依赖位置解析同版本 `@openai/codex` 及平台包，运行常驻 app-server。依赖操作由用户执行。部署见[模型运行时说明](../ai-data/MODEL-RUNTIME.md)。
- API 与 DAS 的 ESM 构建通过 Node `createRequire` 加载依赖；API 发布同时保留 `query-analysis`、`query-dsl` 两份 Skill 的相对路径。
- 模型调用、工具合同、两角色权限及 API/DAS/SQL 链路已有当前版本验收，复跑入口见[测试运行说明](../ai-data/TESTING.md)。
