import { randomUUID } from "node:crypto";
import { z } from "zod";
import dayjs from "dayjs";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AnalysisRunState } from "@ai-data/contracts";
import type { RunChange } from "./analysis-run-types";

/** 调用方已持有会话行锁，消息序号、运行终态和事件在同一事务推进。 */
async function persistRunMessages(
  executor: MetadataQueryExecutor,
  state: AnalysisRunState,
  messages: RunChange["messages"],
): Promise<void> {
  for (const message of messages ?? []) {
    const content = z.string().min(1).max(64000).parse(message.content);
    await executor.execute({
      sql: `INSERT INTO dbo.conversation_messages (id,conversation_id,role,content,sequence,created_at,analysis_run_id)
        SELECT @id,@conversation,@role,@content,COALESCE(MAX(sequence),-1)+1,@now,@run
        FROM dbo.conversation_messages WHERE conversation_id=@conversation;
        UPDATE dbo.conversations SET updated_at=@now WHERE id=@conversation;`,
      parameters: [
        { name: "id", type: "string", value: randomUUID() },
        { name: "conversation", type: "string", value: state.conversation_id },
        { name: "role", type: "string", value: message.role },
        { name: "content", type: "string", value: content },
        { name: "now", type: "date", value: dayjs().toDate() },
        { name: "run", type: "string", value: state.analysis_run_id },
      ],
    });
  }
}
export { persistRunMessages };
