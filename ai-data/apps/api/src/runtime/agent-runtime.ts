import { z } from "zod";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AgentService } from "../agents/agent-service";
import type { ModelService } from "../models/model-service";
import type { SkillSnapshotStore } from "../skills/skill-snapshot-store";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { contextBudget } from "./context-budget";

/** 迁移前的会话允许未绑定；两个字段须同时为空或同时提供。 */
const bindingSchema = z
  .object({
    agent_id: z.string().min(1).nullable(),
    agent_version: z.number().int().positive().nullable(),
  })
  .strict()
  .refine((row) => (row.agent_id === null) === (row.agent_version === null));

/** 会话首次绑定及每次执行装配均按当前可信组织和用户定位。 */
class AgentRuntime {
  constructor(
    private readonly dependencies: {
      database: MetadataTransactionalExecutor;
      agents: Pick<AgentService, "get">;
      models: Pick<ModelService, "resolve" | "probe">;
      snapshots: Pick<SkillSnapshotStore, "load">;
    },
  ) {}

  async selectAgent(context: AuthContext, id = "default", version?: number) {
    const agent = await this.dependencies.agents.get(context, id, version);
    if (!agent.enabled) throw new ApplicationError("UNAUTHORIZED", "Agent 已停用");
    await this.dependencies.models.resolve(context, agent.model_id, agent.model_version);
    return { agentId: agent.agent_id, agentVersion: agent.version };
  }

  async resolveRun(context: AuthContext, runId: string) {
    const binding = await this.dependencies.database.transaction(async (executor) => {
      const parameters = [
        { name: "run", type: "string" as const, value: runId },
        { name: "org", type: "string" as const, value: context.organizationId },
        { name: "user", type: "string" as const, value: context.userId },
      ];
      const result = await executor.execute({
        sql: "SELECT c.agent_id,c.agent_version FROM dbo.conversations c WITH (UPDLOCK,HOLDLOCK) JOIN dbo.analysis_runs r ON r.conversation_id=c.id WHERE r.id=@run AND c.organization_id=@org AND c.user_id=@user AND r.organization_id=@org AND r.user_id=@user",
        parameters,
      });
      if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", "分析运行不存在");
      const row = parseStoredRecord(() => bindingSchema.parse(result.rows[0]));
      const selected =
        row.agent_id === null
          ? await this.selectAgent(context)
          : { agentId: row.agent_id, agentVersion: row.agent_version! };
      const boundParameters = [
        ...parameters,
        { name: "agent", type: "string" as const, value: selected.agentId },
        { name: "version", type: "integer" as const, value: selected.agentVersion },
      ];
      if (row.agent_id === null)
        await executor.execute({
          sql: "UPDATE dbo.conversations SET agent_id=@agent,agent_version=@version WHERE id=(SELECT conversation_id FROM dbo.analysis_runs WHERE id=@run) AND organization_id=@org AND user_id=@user AND agent_id IS NULL",
          parameters: boundParameters,
        });
      await executor.execute({
        sql: "UPDATE dbo.analysis_runs SET agent_id=@agent,agent_version=@version WHERE id=@run AND organization_id=@org AND user_id=@user",
        parameters: boundParameters,
      });
      return selected;
    });
    const agent = await this.dependencies.agents.get(
      context,
      binding.agentId,
      binding.agentVersion,
    );
    if (!agent.enabled) throw new ApplicationError("UNAUTHORIZED", "Agent 已停用");
    const provider = await this.dependencies.models.resolve(
      context,
      agent.model_id,
      agent.model_version,
    );
    const capability = await this.dependencies.models.probe(provider);
    const budget = contextBudget({
      serviceWindow: capability.status === "available" ? capability.contextWindow : undefined,
      modelWindow: provider.contextWindow,
      agentWindow: agent.limits.context_window,
    });
    const snapshot = await this.dependencies.snapshots.load(
      context.organizationId,
      agent.agent_id,
      agent.version,
      agent.skill_names,
      agent.skill_fingerprint,
    );
    return {
      agent,
      configuration: {
        provider,
        cwd: snapshot.cwd,
        skills: snapshot.skills,
        timeoutMs: agent.limits.timeout_ms,
        ...budget,
        contextCapability: capability,
      },
      runtimeKey: JSON.stringify({
        agent: agent.agent_id,
        version: agent.version,
        model: agent.model_id,
        modelVersion: agent.model_version,
        skills: agent.skill_fingerprint,
        contextWindow: budget.contextWindow,
        autoCompactTokenLimit: budget.autoCompactTokenLimit,
      }),
    };
  }
}

export { AgentRuntime };
