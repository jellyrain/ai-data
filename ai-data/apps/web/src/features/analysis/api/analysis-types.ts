import type { z } from "zod";
import type {
  conversationSchema,
  messageSchema,
  conversationDetailSchema,
  submittedMessageSchema,
} from "./analysis-schema";
/** 已校验的 HTTP 会话。 */
type Conversation = z.infer<typeof conversationSchema>;
/** 已校验的持久化消息。 */
type ConversationMessage = z.infer<typeof messageSchema>;
/** 恢复会话与历史消息的响应。 */
type ConversationDetail = z.infer<typeof conversationDetailSchema>;
/** 幂等提交确认的消息与运行。 */
type SubmittedMessage = z.infer<typeof submittedMessageSchema>;
export type { Conversation, ConversationMessage, ConversationDetail, SubmittedMessage };
