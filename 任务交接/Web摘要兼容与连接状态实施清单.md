# Web 摘要兼容与连接状态实施清单

日期：2026-10-08。用户明确要求处理导出和模板提交的 HTTP 限制，并在左下角用户区域体现当前连接环境。主代理单独实施，依赖操作为 0。

## 范围

- 新增共享 `sha256Hex`：原生 `crypto.subtle.digest` 可用时继续调用，普通 HTTP 缺失时使用相同 SHA-256 算法计算 UTF-8 内容摘要。导出的内容变化检测及模板定义摘要继续使用相同字符串和校验规则。
- 用户信息区域增加可点击的连接状态。按协议与浏览器 `isSecureContext` 区分 HTTPS 加密、本机 HTTP 和普通 HTTP；说明中区分传输加密与浏览器安全上下文。
- 桌面位于左下角用户区，手机位于导航抽屉底部，沿用现有主题与组件。

## 文件与验证

路径相对于 `ai-data/apps/web/`：新增 `src/shared/crypto/sha256.ts`、`src/shared/security/connection-context.ts`、`src/app/account-footer.vue`；修改 `src/features/exports/export-controller.ts`、`src/features/reports/components/report-template-submit.vue`、`src/app/app-layout.vue`、`src/styles/app.css`。新增相应单元测试与 HTTP 浏览器验收，扩展已有导出生命周期测试，在任务交接追加交付说明与流程图。

验收先确认现有 HTTP 导出缺陷，再检查标准摘要向量、UTF-8、多块及补位边界与服务端摘要的一致性；浏览器验证普通 HTTP 下真实文件导出、模板提交摘要以及左下角提示，检查深浅色和手机布局。执行类型、lint、格式及 Web 构建检查。文件删除为 0，录像关闭。
