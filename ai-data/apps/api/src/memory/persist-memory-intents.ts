import { createHash } from "node:crypto";
import { memoryIntentSchema, stableStringify, type MemoryIntent } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";

/** 与分析状态共用事务；稳定摘要让重试及恢复只产生一个任务。 */
async function persistMemoryIntents(
  executor: MetadataQueryExecutor,
  runId: string,
  intents: MemoryIntent[],
): Promise<void> {
  for (const input of intents) {
    const intent = memoryIntentSchema.parse(input);
    const json = stableStringify(intent);
    const result = await executor.execute({
      sql: `IF NOT EXISTS(SELECT 1 FROM dbo.memory_intents WHERE analysis_run_id=@run AND intent_key=@key)
      BEGIN
        IF (SELECT COUNT(*) FROM dbo.memory_intents WHERE analysis_run_id=@run)>=100 SELECT 1 AS exceeded;
        ELSE INSERT dbo.memory_intents(analysis_run_id,intent_key,intent_json) VALUES(@run,@key,@json);
      END`,
      parameters: [
        { name: "run", type: "string", value: runId },
        { name: "key", type: "string", value: createHash("sha256").update(json).digest("hex") },
        { name: "json", type: "string", value: json },
      ],
    });
    if (result.rows[0]?.exceeded)
      throw new ApplicationError("INVALID_INPUT", "本轮记忆意图数量超过上限");
  }
}

async function enqueueMemoryIntents(
  executor: MetadataQueryExecutor,
  context: AuthContext,
  runId: string,
): Promise<void> {
  await executor.execute({
    sql: `INSERT dbo.memory_events(event_id,organization_id,user_id,session_id,analysis_run_id,intent_key,intent_json)
      SELECT CONVERT(nvarchar(128),NEWID()),@org,@user,@session,i.analysis_run_id,i.intent_key,i.intent_json
      FROM dbo.memory_intents i WHERE i.analysis_run_id=@run
      AND NOT EXISTS(SELECT 1 FROM dbo.memory_events e WHERE e.analysis_run_id=i.analysis_run_id AND e.intent_key=i.intent_key)`,
    parameters: [
      { name: "run", type: "string", value: runId },
      { name: "org", type: "string", value: context.organizationId },
      { name: "user", type: "string", value: context.userId },
      { name: "session", type: "string", value: context.sessionId },
    ],
  });
}

export { persistMemoryIntents, enqueueMemoryIntents };
