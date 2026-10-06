import { z } from "zod";
import {
  agentVersionSchema,
  analysisRunStatusSchema,
  analysisStepSchema,
  queryEvidenceSchema,
} from "@ai-data/contracts";

const id = z.string().min(1);
const iso = z.iso.datetime({ offset: true });
/** 会话接口序列化 Date 为 ISO，边界保留 camelCase，拒绝未知字段。 */
const conversationSchema = z
  .object({
    id,
    organizationId: id,
    userId: id,
    title: z.string().nullable(),
    status: z.enum(["active", "archived"]),
    createdAt: iso,
    updatedAt: iso,
    agentId: id.optional(),
    agentVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) => (value.agentId === undefined) === (value.agentVersion === undefined),
    "Agent 与版本须同时提供",
  );
/** 历史消息可省略运行关联；正文仍可阅读。 */
const messageSchema = z
  .object({
    id,
    conversationId: id,
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    sequence: z.number().int().nonnegative(),
    createdAt: iso,
    analysisRunId: id.optional(),
  })
  .strict();
/** 提交回执使用记录形态，和 snake_case 的可恢复快照分别校验。 */
const runReceiptSchema = z
  .object({
    id,
    conversationId: id,
    organizationId: id,
    userId: id,
    status: analysisRunStatusSchema,
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    startedAt: iso.nullable(),
    completedAt: iso.nullable(),
    createdAt: iso,
  })
  .strict();
const conversationDetailSchema = z
  .object({ conversation: conversationSchema, messages: z.array(messageSchema) })
  .strict()
  .refine(
    (value) => value.messages.every((message) => message.conversationId === value.conversation.id),
    "消息会话不一致",
  );
const submittedMessageSchema = z
  .object({ message: messageSchema, analysisRun: runReceiptSchema })
  .strict()
  .refine(
    (value) =>
      value.message.conversationId === value.analysisRun.conversationId &&
      (!value.message.analysisRunId || value.message.analysisRunId === value.analysisRun.id),
    "运行回执不一致",
  );
const conversationListSchema = z.object({ items: z.array(conversationSchema) }).strict();
const agentListSchema = z.object({ items: z.array(agentVersionSchema) }).strict();
const evidenceListSchema = z.object({ items: z.array(queryEvidenceSchema).max(1000) }).strict();
const stepListSchema = z.object({ items: z.array(analysisStepSchema) }).strict();
export {
  conversationSchema,
  messageSchema,
  conversationDetailSchema,
  submittedMessageSchema,
  conversationListSchema,
  agentListSchema,
  evidenceListSchema,
  stepListSchema,
};
