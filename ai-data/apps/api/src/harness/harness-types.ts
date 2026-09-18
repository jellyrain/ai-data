import type { SkillResources } from "../skills/skill-resources";

/** API 向单次模型分析公开的受控业务工具。 */
type HarnessTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** 工具执行结果；stop 表示业务层已保存澄清问题，需要结束当前模型轮次。 */
type HarnessToolResult = { success: boolean; output: unknown; stop?: boolean };

/** 一次分析尝试的完整上下文；身份和权限始终由 executeTool 所属 API 层执行。 */
type HarnessRequest = {
  /** 由 API 绑定组织、用户、业务会话与授权版本的执行隔离键。 */
  sessionKey: string;
  /** 已经完成权限复核的官方会话标识。 */
  threadId?: string;
  /** 官方会话建立后立即保存，确保进程恢复可找到同一会话。 */
  onThreadStarted: (threadId: string) => Promise<void>;
  /** 官方压缩事件在返回最终结果前按顺序交由 API 持久化。 */
  onCompaction?: (event: HarnessCompaction) => Promise<void>;
  input: string;
  instructions: string;
  tools: HarnessTool[];
  signal: AbortSignal;
  executeTool: (name: string, input: unknown, callId: string) => Promise<HarnessToolResult>;
};

/** 官方上下文压缩条目的实际生命周期。 */
type HarnessCompaction = { itemId: string; status: "started" | "completed" };

/** 模型执行的正常结束状态；失败与取消通过已分类异常返回。 */
type HarnessResult = { status: "completed"; content: string } | { status: "waiting_clarification" };

/** 分析执行器依赖的官方 Harness 适配边界。 */
interface AnalysisHarness {
  run(request: HarnessRequest): Promise<HarnessResult>;
}

/** 支持 Responses 的模型提供方；地址、模型和认证由部署配置提供。 */
type CodexModelProviderConfig = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

/** 官方运行时状态目录及单轮时限，工具次数由 API 执行器限制。 */
type CodexHarnessOptions = {
  provider: CodexModelProviderConfig;
  stateDirectory: string;
  skills?: SkillResources;
  timeoutMs: number;
  contextWindow?: number;
};

export type {
  HarnessTool,
  HarnessToolResult,
  HarnessRequest,
  HarnessCompaction,
  HarnessResult,
  AnalysisHarness,
  CodexModelProviderConfig,
  CodexHarnessOptions,
};
