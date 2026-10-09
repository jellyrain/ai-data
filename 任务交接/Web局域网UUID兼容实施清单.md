# Web 局域网 UUID 兼容实施清单

日期：2026-10-08。用户报告 Web dev 监听 `0.0.0.0` 后发送对话触发 `crypto.randomUUID is not a function`，审核排查后的修复清单并回复“可以”。主代理单独实施，依赖操作为 0。

## 目的与范围

普通 HTTP 局域网来源中的浏览器保留 `crypto.getRandomValues()`，但不暴露要求安全上下文的 `crypto.randomUUID()`。新增共享 UUID 方法，优先调用原生方法，缺失时从加密随机字节生成标准 v4 UUID；现有请求的幂等键保存与重试逻辑继续负责同次操作的键复用。

## 文件清单

以下路径相对于 `ai-data/apps/web/`：

- 新增 `src/shared/identity/create-uuid.ts`。
- 修改 9 个现有文件中的 16 处 UUID 调用：`features/analysis/stores/analysis-workspace.ts`、`features/reports/stores/report-workspace.ts`、`report-revisions.ts`、`report-narratives.ts`、`features/reports/components/presentation-editor.vue`、`report-template-submit.vue`、`features/knowledge/components/knowledge-board.vue`、`features/preferences/components/preferences-panel.vue`、`shared/content/diagram.ts`，以上均位于 `src/`。
- 新增 `tests/shared/identity/create-uuid.test.ts`、`tests/e2e/http-uuid.spec.ts`；调整 `tests/features/analysis/analysis-workspace.test.ts`，验证加密随机字节、UUID 格式、请求重试及普通 HTTP 来源。浏览器保留测试域名来源，通过路由改写将网络请求发送到本机隔离服务。
- 在任务交接保存实施与交付记录，追加 README 入口。

文件删除为 0。使用现有依赖、浏览器及隔离 API 测试服务。Web 的 dev/preview 监听设置沿用用户当前配置。

## 验收场景

| 前提与操作                           | 预期                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| 浏览器支持原生 UUID                  | 使用原生实现并保留 Crypto 接收者                         |
| 原生 UUID 缺失，存在加密随机数 API   | 生成 36 字符、版本 4、标准变体的 UUID                    |
| 发送后回执丢失，重复点击及重试       | 一个在途请求；重试沿用原问题与幂等键                     |
| 普通 HTTP 测试域名映射到本机隔离服务 | 确认非安全上下文，发送和重试成功，流程图正常渲染         |
| 回归与构建                           | 相关单元测试、Web 类型、修改文件 lint/格式、Web 构建通过 |

测试先确认目标缺陷，再替换生产调用并复验。浏览器测试关闭录像。
