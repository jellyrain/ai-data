import type { z } from "zod";
import type {
  agentLimitsSchema,
  agentDefinitionSchema,
  agentVersionSchema,
  skillCatalogEntrySchema,
  agentToolEntrySchema,
  createConversationSchema,
} from "./agent";

/** 单轮 Agent 执行预算。 */
type AgentLimits = z.infer<typeof agentLimitsSchema>;
/** 发布时使用的 Agent 完整定义。 */
type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
/** 固定资源版本和实时启用状态的 Agent 记录。 */
type AgentVersion = z.infer<typeof agentVersionSchema>;
/** 可供绑定的 Skill 元信息。 */
type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
/** 可供绑定的已注册业务工具。 */
type AgentToolEntry = z.infer<typeof agentToolEntrySchema>;
/** 创建会话与选择 Agent 的输入。 */
type CreateConversation = z.infer<typeof createConversationSchema>;

export type {
  AgentLimits,
  AgentDefinition,
  AgentVersion,
  SkillCatalogEntry,
  AgentToolEntry,
  CreateConversation,
};
