import type { Aes256GcmSecretCipher, ActiveMasterKeyProvider } from "@ai-data/metadata/secrets";
import type { SecretRepository } from "../metadata/secret-repository";
import type { SqlDataSourceAdministration } from "../metadata/sql-data-source-administration";
import type { DatabaseTargetDiscovery } from "./database-target-discovery";
/** 连接管理复用现有密文仓储、主密钥和运行时池失效机制。 */
type DatabaseConnectionDependencies = {
  repository: Pick<SecretRepository, "findBySecretRef" | "replace">;
  administration: Pick<SqlDataSourceAdministration, "sources" | "secrets" | "deleteConnection">;
  keys: ActiveMasterKeyProvider;
  cipher: Aes256GcmSecretCipher;
  discovery: DatabaseTargetDiscovery;
  runtime: { invalidateBySecretRef(secretRef: string): Promise<void> };
};
export type { DatabaseConnectionDependencies };
