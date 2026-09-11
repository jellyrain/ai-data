# AI BI 开发规范

版本：v0.2  
状态：生效  
设计基线日期：2026-09-11  
适用范围：当前工作区全部应用与共享包  
关联文档：[technical-design.md](./technical-design.md) · [contracts.md](./contracts.md) · [development-checklist.md](./development-checklist.md)

## 1. 目标

本规范保证 AI BI 的代码具备一致的结构、可读的业务边界、可验证的合同和可追溯的查询行为。

## 2. 通用原则

- 使用 Node.js、TypeScript、pnpm Workspace。
- 业务数据查询只能表达为受控 DSL，并由 Data Access Service 编译为参数化只读请求。
- API 管理用户、组织、业务关系、指标统计规则和权限，生成最终可执行 DSL；Data Access Service 完成校验、执行、匿名化/脱敏和返回。
- 对外输入、跨服务通信和持久化边界必须先校验，再进入业务逻辑。
- 优先写清楚业务意图和边界，再抽取通用代码。
- 每次变更只覆盖当前需求相关范围，并保留已有有效实现。
- 开始开发任务前，必须先读取并遵守 `no-negative-echo` 和 `stop-that-shit` Skill，如果已经读过，就不需要再读，除非对于skill规范不确定了才再读
- 两个 Skill 的要求发生冲突时，以 `stop-that-shit` 为准。

## 3. Monorepo 目录规范

```text
ai-data/
├─ apps/
│  ├─ web/                 Vue Web 应用
│  ├─ api/                 Fastify API 与 Agent Gateway
│  └─ data-access/         独立只读 Data Access Service
├─ packages/
│  ├─ contracts/           Zod Schema 与共享 TypeScript 类型
│  ├─ metadata/            元数据库接口与 SQL Server 实现
│  ├─ domain/              指标、记忆、审核、报告领域逻辑
│  ├─ skills/              Git 管理的 Skill Markdown
│  └─ config/              非敏感配置和配置读取逻辑
└─ package.json            根脚本与 Workspace 管理
```

规则：

- `apps` 放可独立启动、构建和部署的应用。
- `packages` 放被一个或多个应用复用的代码、合同或资源。
- 业务功能按领域或 feature 分类，避免把所有文件堆放在 `src` 根目录。
- 测试统一放在对应包的 `tests` 目录，不放入 `src`。
- 测试目录镜像 `src` 的业务分类结构。

## 4. TypeScript 文件与命名规范

| 对象           | 规范                                                   | 示例                                       |
| -------------- | ------------------------------------------------------ | ------------------------------------------ |
| 文件名         | 小写 kebab-case。                                      | `data-access-request.ts`                   |
| 分类目录       | 小写 kebab-case，按职责命名。                          | `access/`、`query/`                        |
| 变量与函数     | camelCase，名称体现业务动作或含义。                    | `queryAccessContextSchema`、`compileQuery` |
| 类型、接口、类 | PascalCase。                                           | `QueryAccessContext`、`QueryResult`        |
| 常量           | camelCase；仅真正全局不变的常量使用 UPPER_SNAKE_CASE。 | `maxQueryLimit`、`DEFAULT_TIMEOUT_MS`      |
| API / DSL 字段 | 使用项目已定义的 snake_case 合同字段。                 | `source_id`、`analysis_run_id`             |
| 布尔值         | 使用 `is`、`has`、`can`、`supports` 等可读前缀。       | `isHealthy`、`supportsJoins`               |

## 5. Imports 与 Exports

### 5.1 Imports

- TypeScript 相对导入不写 `.js` 或 `.ts` 扩展名。
- 类型导入使用 `import type`。
- 第三方依赖导入在前，相对导入在后。
- 只导入当前文件实际使用的内容。
- 应用使用共享合同时统一从 `@ai-data/contracts` 导入，不引用其内部 `src` 路径。

```ts
import { z } from "zod";

import type { QueryAccessContext } from "@ai-data/contracts";
import { queryAccessContextSchema } from "@ai-data/contracts";
```

### 5.2 Exports

- 一个文件的 export 统一放在文件最后。
- Schema 文件只导出运行时 Schema。
- `*-types.ts` 文件只导出 TypeScript 类型。
- `packages/contracts/src/index.ts` 是 contracts 的唯一公共出口。
- 新增公共合同后，必须同步加入 `src/index.ts`。

```ts
export { queryAccessContextSchema };

export type { QueryAccessContext };
```

## 6. Zod 合同规范

### 6.1 Schema 与类型分离

每个合同分类使用一对文件：

```text
query/
├─ data-access-request.ts        Zod Schema
└─ data-access-request-types.ts  从 Schema 推导的 TypeScript 类型
```

类型必须从 Schema 推导，避免运行时校验和编译期类型出现两套不一致的定义。

```ts
/** API 传给 Data Access Service 的查询审计上下文类型。 */
type QueryAccessContext = z.infer<typeof queryAccessContextSchema>;
```

### 6.2 Schema 编写要求

- 所有服务边界对象使用 `.strict()`。
- 字符串 ID 使用 `.min(1, "字段名 不能为空")`。
- 数据对象、字段、别名等 SQL 标识符使用固定正则白名单。
- 枚举只列出当前已审核的能力或状态。
- 需要默认值时使用 `.default(...)`，并在注释中说明默认行为。
- 互斥字段、依赖字段和操作符组合使用 `.superRefine(...)` 校验。
- 查询结果行数、分页量、超时等资源边界必须有明确上限。
- 日期时间使用东八区 `YYYY-MM-DD HH:mm:ss`，并校验真实日期。

### 6.3 Zod 注释规范

每个 Schema 必须具备以下中文注释：

| 位置                                        | 必须说明                     |
| ------------------------------------------- | ---------------------------- |
| Schema 声明前                               | 该对象用于什么业务边界。     |
| 每个字段前                                  | 字段的业务含义和调用方。     |
| `.string()`、`.number()`、`.array()` 等     | 为什么使用该基础类型。       |
| `.min()`、`.max()`、`.int()`、`.positive()` | 该范围或格式限制保护什么。   |
| `.enum()`                                   | 枚举值代表的能力或状态。     |
| `.optional()`、`.default()`                 | 字段省略后的含义或默认行为。 |
| `.strict()`                                 | 拒绝未知字段的边界目的。     |
| `.refine()`、`.superRefine()`               | 跨字段或业务约束的原因。     |

示例：

```ts
/** API 传给 Data Access Service 的本次查询审计上下文。 */
const queryAccessContextSchema = z
  .object({
    /** 当前分析运行 ID，用于审计和取消。 */
    analysis_run_id: z
      /** 分析运行 ID 必须是字符串。 */
      .string()
      /** 空字符串无法关联本次运行。 */
      .min(1, "analysis_run_id 不能为空"),
  })
  /** 服务边界只接受合同中声明的字段。 */
  .strict();
```

## 7. 注释规范

### 7.1 注释语言与内容

- 业务代码、合同、测试和重要配置使用中文注释。
- 注释解释“为什么这样设计、数据从哪里来、对什么边界生效”。
- 函数名已清楚表达的简单赋值、循环或语法行为不重复写无信息注释。
- 权限、数据源、SQL 编译、口径、记忆和审计相关逻辑必须说明安全或业务原因。
- TypeScript 类型别名、接口和枚举都必须有用途注释。

### 7.2 JSDoc

以下内容使用 `/** ... */`：

- Schema、类型、接口、类、公共函数。
- 对象字段。
- 重要常量。
- 非直观的规则、算法和数据转换。

```ts
/** API 已计算的一条行级授权范围类型。 */
type ResolvedRowScope = z.infer<typeof resolvedRowScopeSchema>;
```

## 8. 权限与 Data Access Service 规范

- API 保存角色对象权限、列权限和行策略，以及批准关系、数据集粒度、唯一键、关联基数和指标统计规则。
- API 在每次工具查询时依据当前身份重新校验权限，完成对象、字段、Join、参数、行条件、去重和聚合处理，再生成最终 DSL。
- `access` 至少包含用户、组织、分析运行、策略版本、过期时间和结果脱敏规则。
- 模型只调用 API 工具；API 每次调用 Data Access Service 时构建 `{ access, query, signature }`，并在受信任请求头携带短时 JWT。
- API 按 DSL 别名、对象范围和关联语义放置条件。主对象权限独立生效；需要保留主记录的外连接，可选侧限制采用对象预过滤或对应 `ON` 条件；查询级筛选放入 `query.filters`。`signature` 必须覆盖 `access` 与最终 `query`。
- 参数化数据集存在行限制时，API 通过受控参数强制绑定并校验授权范围；缺少可执行的权限参数时拒绝查询。固定输出同样执行列权限校验和输出脱敏规则计算。
- 关联可能导致业务记录重复时，API 按指标的去重键、聚合层次和总计规则生成查询。不同日期依据使用独立指标定义，执行记录保存固定时间依据及实际对象、字段和指标版本。
- Data Access Service 校验 JWT、整体签名、过期时间、本地数据源、对象白名单和可编译性。
- Data Access Service 只能执行 DSL 编译得到的参数化只读请求。
- Data Access Service 返回标准化结果、列信息、截断状态和可选新鲜度；审计关联信息写入 DAS 自身审计库。

### 8.1 分析、报告与运行规范

- Skill 描述通用分析方法、查询分支判断和结束条件，模型根据运行时指标定义、授权目录及证据决定实际分析路径。真实案例用于完善方法，确定性计算与权限控制由 API/工具执行。
- 报表模板按当前访问者权限执行；历史快照的查看、分享和导出同时校验报告访问权及其完整数据范围。权限不足或覆盖范围无法确认时拒绝原快照，可创建按访问者权限执行的新结果。
- API 持久化组织、用户、会话和运行归属，隔离 Agent 上下文，并对 SSE 订阅、回放和所有运行操作校验身份。
- 运行状态按合法状态转换原子更新；操作使用幂等键，澄清回答绑定待处理问题，状态与事件同事务提交。执行租约使用递增代次，过期执行器的提交被拒绝；取消后晚到结果不能覆盖终态。
- 第一版同一会话串行推进运行，不同会话可以并行。恢复依据持久化状态、问题、事件和执行检查点进行。
- 新增 DSL 或运行合同能力先完成共享 Schema、生成与执行支持及场景验收，再开放相应查询。设计文档中的待实现要求与代码完成状态分别维护。

## 9. 测试规范

所有应用和共享包的测试必须以 BDD 场景和 TDD 断言编写。新增功能、缺陷修复、重构及其他模块对该行为的使用，均以对应测试定义的行为为准；行为需要变化时，必须先新增或更新测试，再修改实现。

### 9.1 测试位置与命名

```text
src/query/query-dsl.ts
tests/query/query-dsl.test.ts
```

- 测试文件使用 `*.test.ts`。
- 测试目录按业务分类镜像源代码目录。
- 测试描述使用中文。
- 每个 `it(...)` 前写一条中文 BDD/TDD 注释。

```ts
// BDD 场景：Agent 生成最小合法查询；TDD 断言：Schema 自动补齐默认数组。
it("接受最小关系查询并补齐默认值", () => {
  // 测试内容
});
```

### 9.2 合同测试要求

每个 Schema 至少覆盖：

- 合法输入。
- 缺失必填字段。
- 不合法枚举、格式、范围或日期。
- 未知字段被 `.strict()` 拒绝。
- `superRefine`、权限范围、资源上限等关键业务边界。

权限和查询相关合同还必须覆盖：

- 未授权对象。
- 未授权字段。
- 无效行范围。
- 查询上限。
- SQL 标识符注入片段。

端到端行为还必须覆盖：外连接可选侧无匹配行、主对象权限、多明细重复统计、参数化查询权限不可表达、固定时间口径、快照数据范围不足、重复澄清提交、取消后的晚到结果、租约接管后的旧执行器提交，以及跨用户事件订阅。

## 10. 文档规范

- 架构、合同、依赖和开发清单分别维护在 `需求文档` 目录。
- 代码行为改变时，同步更新对应设计文档和开发清单。
- 文档示例使用虚构 ID、测试数据或脱敏数据。
- 文档中的字段名、事件名、工具名和目录结构必须与当前代码合同一致。
- 每个新协议、新服务边界或重要决策都要有明确的职责、输入、输出和调用方说明。

## 11. 提交前验证

修改一个包后，在该包目录或根目录执行：

```powershell
pnpm --filter @ai-data/contracts format:check
pnpm --filter @ai-data/contracts typecheck
pnpm --filter @ai-data/contracts test
```

各应用和共享包完成后，根目录统一执行：

```powershell
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

验证失败时，先定位失败的合同、类型、格式或测试边界，再提交后续变更。

## 12. 新功能变更清单

新增功能时依次确认：

1. 所属应用或共享包是否正确。
2. 是否需要新增或修改跨服务 Zod 合同。
3. Schema、类型和注释是否同步完成。
4. 公共 contracts 是否已从 `src/index.ts` 导出。
5. 合法、非法和边界测试是否覆盖。
6. 权限、审计、数据新鲜度和只读边界是否明确。
7. 设计文档与开发清单是否同步。
8. 格式、类型检查、测试和构建是否通过。
