import type { AgentDefinition, AgentVersion } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";

/** Agent 定义按组织和版本保存，启停状态属于稳定 Agent 标识。 */
interface AgentRepository {
  /** 原子检查连续版本并保存定义，返回当前启停状态。 */
  publish(
    organizationId: string,
    definition: AgentDefinition,
    skillFingerprint: string,
  ): Promise<AgentVersion>;
  /** 省略版本时读取最新发布定义，所有读取均限定组织。 */
  find(organizationId: string, agentId: string, version?: number): Promise<AgentVersion | null>;
  /** 返回本组织每个 Agent 的最新发布版本。 */
  list(organizationId: string): Promise<AgentVersion[]>;
  /** 修改当前状态；资源不存在时返回 false。 */
  setEnabled(organizationId: string, agentId: string, isEnabled: boolean): Promise<boolean>;
}

/** 发布服务通过具名依赖校验模型、工具与固定 Skill 快照。 */
interface AgentServiceDependencies {
  repository: AgentRepository;
  /** 校验模型版本存在并允许用于当前组织的新发布配置。 */
  resolveModel(context: AuthContext, modelId: string, modelVersion: number): Promise<void>;
  /** 创建当前 Agent 版本的完整资源快照，返回绑定内容摘要。 */
  prepareSkills(
    organizationId: string,
    agentId: string,
    version: number,
    skillNames: string[],
  ): Promise<{ fingerprint: string }>;
  /** 返回后端实际注册的工具名称。 */
  listToolNames(): readonly string[];
}

export type { AgentRepository, AgentServiceDependencies };
