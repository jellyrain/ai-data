import {
  agentDefinitionSchema,
  agentVersionSchema,
  type AgentDefinition,
  type AgentVersion,
} from "@ai-data/contracts";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { agentStatusSchema, parseAgentRecord } from "./agent-records";
import type { AgentRepository } from "./agent-types";

/** SQL 事务固定 Agent 版本顺序，当前启停状态独立于历史定义。 */
class SqlAgentRepository implements AgentRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  async publish(
    organizationId: string,
    input: AgentDefinition,
    skillFingerprint: string,
  ): Promise<AgentVersion> {
    const definition = agentDefinitionSchema.parse(input);
    const version = agentVersionSchema.parse({
      ...definition,
      skill_fingerprint: skillFingerprint,
      enabled: true,
    });
    return this.database.transaction(async (executor) => {
      const parameters = [
        { name: "org", type: "string" as const, value: organizationId },
        { name: "id", type: "string" as const, value: definition.agent_id },
      ];
      // 主键上的更新/范围锁将同一组织 Agent 的首次发布、后续发布及启停排序。
      const current = await executor.execute({
        sql: "SELECT enabled FROM dbo.agents WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND agent_id=@id",
        parameters,
      });
      const status = current.rows[0]
        ? parseStoredRecord(() => agentStatusSchema.parse(current.rows[0]))
        : null;
      const latest = await executor.execute({
        sql: "SELECT TOP (1) d.agent_id,d.version,d.definition_json,d.skill_fingerprint,a.enabled FROM dbo.agent_definitions d JOIN dbo.agents a ON a.organization_id=d.organization_id AND a.agent_id=d.agent_id WHERE d.organization_id=@org AND d.agent_id=@id ORDER BY d.version DESC",
        parameters,
      });
      const previous = latest.rows[0] ? parseAgentRecord(latest.rows[0]) : null;
      if (Boolean(status) !== Boolean(previous))
        throw new ApplicationError("INTERNAL_ERROR", "Agent 版本记录不完整");
      if (definition.version !== (previous?.version ?? 0) + 1)
        throw new ApplicationError("CONFLICT", "Agent 版本必须顺序递增，已发布版本不可改写");
      if (!status)
        await executor.execute({
          sql: "INSERT INTO dbo.agents (organization_id,agent_id,enabled) VALUES (@org,@id,1)",
          parameters,
        });
      await executor.execute({
        sql: "INSERT INTO dbo.agent_definitions (organization_id,agent_id,version,definition_json,skill_fingerprint) VALUES (@org,@id,@version,@json,@fingerprint)",
        parameters: [
          ...parameters,
          { name: "version", type: "integer", value: definition.version },
          { name: "json", type: "string", value: JSON.stringify(definition) },
          { name: "fingerprint", type: "string", value: version.skill_fingerprint },
        ],
      });
      return { ...version, enabled: status?.enabled ?? true };
    });
  }

  async find(
    organizationId: string,
    agentId: string,
    version?: number,
  ): Promise<AgentVersion | null> {
    const result = await this.database.execute({
      sql: "SELECT TOP (1) d.agent_id,d.version,d.definition_json,d.skill_fingerprint,a.enabled FROM dbo.agent_definitions d JOIN dbo.agents a ON a.organization_id=d.organization_id AND a.agent_id=d.agent_id WHERE d.organization_id=@org AND d.agent_id=@id AND (@version IS NULL OR d.version=@version) ORDER BY d.version DESC",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: agentId },
        { name: "version", type: "integer", value: version ?? null },
      ],
    });
    return result.rows[0] ? parseAgentRecord(result.rows[0]) : null;
  }

  async list(organizationId: string): Promise<AgentVersion[]> {
    const result = await this.database.execute({
      sql: "SELECT agent_id,version,definition_json,skill_fingerprint,enabled FROM (SELECT d.agent_id,d.version,d.definition_json,d.skill_fingerprint,a.enabled,ROW_NUMBER() OVER (PARTITION BY d.agent_id ORDER BY d.version DESC) AS ordinal FROM dbo.agent_definitions d JOIN dbo.agents a ON a.organization_id=d.organization_id AND a.agent_id=d.agent_id WHERE d.organization_id=@org) versions WHERE ordinal=1 ORDER BY agent_id",
      parameters: [{ name: "org", type: "string", value: organizationId }],
    });
    return result.rows.map(parseAgentRecord);
  }

  async setEnabled(organizationId: string, agentId: string, isEnabled: boolean): Promise<boolean> {
    const result = await this.database.execute({
      sql: "UPDATE dbo.agents SET enabled=@enabled OUTPUT inserted.agent_id WHERE organization_id=@org AND agent_id=@id",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: agentId },
        { name: "enabled", type: "boolean", value: isEnabled },
      ],
    });
    return result.rows.length > 0;
  }
}

export { SqlAgentRepository };
