import { createHash } from "node:crypto";
import { modelConfigurationInputSchema, type ModelConfiguration } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { CodexModelProviderConfig } from "../harness/harness-types";
import { ApplicationError } from "../errors/application-error";
import type { ModelRepository } from "./model-types";
import type { ModelCredentialCipher } from "./model-credential-cipher";
import type { ModelCapabilities } from "./model-capabilities";

/** 模型定义按组织和版本固定；实际认证仅在服务端运行装配时读取。 */
class ModelService {
  constructor(
    private readonly dependencies: {
      repository: ModelRepository;
      credentials: Pick<ModelCredentialCipher, "encrypt" | "decrypt">;
      capabilities: Pick<ModelCapabilities, "probe">;
    },
  ) {}
  private assertManager(context: AuthContext) {
    if (!context.roles.includes("system_admin") && !context.permissions.includes("models:manage"))
      throw new ApplicationError("UNAUTHORIZED", "无模型管理权限");
  }
  async publish(context: AuthContext, value: unknown): Promise<ModelConfiguration> {
    this.assertManager(context);
    const input = modelConfigurationInputSchema.parse(value);
    const { api_key, headers, ...definition } = input;
    const credentials = await this.dependencies.credentials.encrypt({
      ...(api_key ? { api_key } : {}),
      ...(headers ? { headers } : {}),
    });
    return this.dependencies.repository.publish(context.organizationId, {
      credentials,
      configuration: {
        ...definition,
        enabled: true,
        has_api_key: !!api_key,
        header_names: Object.keys(headers ?? {}).sort(),
      },
    });
  }
  async list(context: AuthContext): Promise<ModelConfiguration[]> {
    return this.dependencies.repository.list(context.organizationId);
  }
  async get(context: AuthContext, id: string, version?: number): Promise<ModelConfiguration> {
    const row = await this.dependencies.repository.find(context.organizationId, id, version);
    if (!row) throw new ApplicationError("NOT_FOUND", "模型配置不存在");
    return row.configuration;
  }
  async setEnabled(context: AuthContext, id: string, enabled: boolean): Promise<void> {
    this.assertManager(context);
    if (!(await this.dependencies.repository.setEnabled(context.organizationId, id, enabled)))
      throw new ApplicationError("NOT_FOUND", "模型配置不存在");
  }
  async resolve(
    context: AuthContext,
    id: string,
    version: number,
  ): Promise<CodexModelProviderConfig & { contextWindow?: number }> {
    const row = await this.dependencies.repository.find(context.organizationId, id, version);
    if (!row) throw new ApplicationError("NOT_FOUND", "模型配置不存在");
    const config = row.configuration;
    if (!config.enabled) throw new ApplicationError("INVALID_INPUT", "模型已停用");
    const credentials = await this.dependencies.credentials.decrypt(row.credentials);
    return {
      id: `model_${createHash("sha256")
        .update(JSON.stringify([context.organizationId, id, version]))
        .digest("hex")}`,
      model: config.model,
      baseUrl: config.base_url,
      apiKey: credentials.api_key,
      headers: credentials.headers,
      contextWindow: config.context_window,
    };
  }
  /** 配置校验和发布不访问上游；运行装配在数据库事务结束后调用此方法。 */
  probe(provider: CodexModelProviderConfig) {
    return this.dependencies.capabilities.probe(provider);
  }
}

export { ModelService };
