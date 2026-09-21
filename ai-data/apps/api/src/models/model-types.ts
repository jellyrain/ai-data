import type { ModelConfiguration, ModelConfigurationInput } from "@ai-data/contracts";
import type { z } from "zod";
import type { encryptedModelCredentialsSchema } from "./model-credentials";

/** 服务端保存的模型认证；API 公共响应只返回是否配置认证。 */
type ModelCredentials = Pick<ModelConfigurationInput, "api_key" | "headers">;
/** 模型凭据密文及解密所需的主密钥版本和认证元数据。 */
type EncryptedModelCredentials = z.infer<typeof encryptedModelCredentialsSchema>;
/** 元数据库中同时保存模型版本定义与该版本的认证密文。 */
type StoredModel = { configuration: ModelConfiguration; credentials: EncryptedModelCredentials };
/** 模型版本与实时启停状态的持久化接口。 */
interface ModelRepository {
  publish(organizationId: string, model: StoredModel): Promise<ModelConfiguration>;
  find(organizationId: string, modelId: string, version?: number): Promise<StoredModel | null>;
  list(organizationId: string): Promise<ModelConfiguration[]>;
  setEnabled(organizationId: string, modelId: string, enabled: boolean): Promise<boolean>;
}
export type { ModelCredentials, EncryptedModelCredentials, StoredModel, ModelRepository };
