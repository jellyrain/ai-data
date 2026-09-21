import { z } from "zod";

/** 资源标识用于业务引用；文件系统目录由 API 派生，标识不直接作为路径。 */
const resourceIdSchema = z.string().min(1).max(128);
/** Skill 源目录名使用稳定的小写标识。 */
const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** 单轮执行限制沿用已有 API 能力边界；省略上下文窗口时由模型配置决定。 */
const agentLimitsSchema = z
  .object({
    timeout_ms: z.number().int().min(1000).max(600000),
    max_tool_calls: z.number().int().min(1).max(100),
    max_context_bytes: z.number().int().min(4096).max(1048576),
    context_window: z.number().int().min(4096).max(2097152).optional(),
  })
  .strict();
/** 已发布 Agent 配置不可原位更新；模型及资源引用属于本版本，未知字段拒绝。 */
const agentDefinitionSchema = z
  .object({
    agent_id: resourceIdSchema,
    version: z.number().int().positive(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    instructions: z.string().max(16000).default(""),
    model_id: resourceIdSchema,
    model_version: z.number().int().positive(),
    tool_names: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/))
      .max(32)
      .refine((items) => new Set(items).size === items.length, "工具不能重复"),
    skill_names: z
      .array(skillNameSchema)
      .max(100)
      .refine((items) => new Set(items).size === items.length, "Skill 不能重复"),
    limits: agentLimitsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.skill_names.length && !value.tool_names.includes("read_skill_reference"))
      context.addIssue({
        code: "custom",
        path: ["tool_names"],
        message: "绑定 Skill 时须启用子文档读取工具",
      });
  });
/** 完整资源指纹固定入口及子文档；enabled 表达当前 Agent 的运行开关。 */
const agentVersionSchema = agentDefinitionSchema.safeExtend({
  skill_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean(),
});
/** 源资源目录向管理接口公开的元信息，不含部署绝对路径。 */
const skillCatalogEntrySchema = z
  .object({
    name: skillNameSchema,
    description: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** 已注册的业务工具，供 Agent 配置选择。 */
const agentToolEntrySchema = z
  .object({ name: z.string().min(1), description: z.string() })
  .strict();
/** 新会话可选指定 Agent；省略时使用服务提供的默认配置，版本依赖 Agent 标识。 */
const createConversationSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    agent_id: resourceIdSchema.optional(),
    agent_version: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.agent_version !== undefined && !value.agent_id)
      context.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "指定版本时必须提供 Agent 标识",
      });
  });

export {
  agentLimitsSchema,
  agentDefinitionSchema,
  agentVersionSchema,
  skillCatalogEntrySchema,
  agentToolEntrySchema,
  createConversationSchema,
};
