import { z } from "zod";
import {
  agentDefinitionSchema,
  agentVersionSchema,
  agentToolEntrySchema,
  skillCatalogEntrySchema,
  type AgentDefinition,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
import { publishVersion } from "../../../shared/management/version-publication";
/** 源文档与版本指纹分开读取，公开响应拒绝部署文件路径等额外字段。 */
const skillDocumentSchema = z
  .object({ skill_name: z.string().min(1), relative_path: z.string().min(1), content: z.string() })
  .strict();
class AgentApi {
  constructor(private readonly request: Transport) {}
  async list() {
    return z
      .object({ items: z.array(agentVersionSchema) })
      .strict()
      .parse(await this.request("/api/agents")).items;
  }
  async get(id: string, version?: number) {
    return agentVersionSchema.parse(
      await this.request(
        `/api/agents/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`,
      ),
    );
  }
  async tools() {
    return z
      .object({ items: z.array(agentToolEntrySchema) })
      .strict()
      .parse(await this.request("/api/agent-tools")).items;
  }
  async skills() {
    return z
      .object({ items: z.array(skillCatalogEntrySchema) })
      .strict()
      .parse(await this.request("/api/skills")).items;
  }
  async document(name: string, path: string) {
    return skillDocumentSchema.parse(
      await this.request(
        `/api/skills/${encodeURIComponent(name)}?${new URLSearchParams({ path })}`,
      ),
    );
  }
  publish(input: AgentDefinition) {
    return publishVersion({
      request: this.request,
      path: "/api/agents",
      id: input.agent_id,
      input: agentDefinitionSchema.parse(input),
      schema: agentVersionSchema,
      secret: false,
    });
  }
  async status(id: string, enabled: boolean) {
    z.undefined().parse(
      await this.request(`/api/agents/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        body: { enabled },
      }),
    );
  }
}
export { AgentApi };
