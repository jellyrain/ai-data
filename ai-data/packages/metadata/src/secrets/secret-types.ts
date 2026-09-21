/** AES-GCM 解密所需的随机 IV 和认证标签。 */
interface AesGcmEncryptionMetadata {
  /** 12 字节随机初始化向量的十六进制文本。 */
  iv_hex: string;
  /** 16 字节 GCM 认证标签的十六进制文本。 */
  auth_tag_hex: string;
}

/** 可持久化到元数据库的一段 AES-GCM 密文。 */
interface AesGcmEncryptedPayload {
  /** 不包含认证标签的 AES-GCM 密文。 */
  encryptedPayload: Buffer;
  /** 解密时需要的 IV 和认证标签。 */
  metadata: AesGcmEncryptionMetadata;
}

/** 本地密钥库中当前用于新密文的 AES 主密钥。 */
interface ActiveMasterKey {
  /** 主密钥版本标识，同时用于定位原始密钥文件。 */
  keyId: string;
  /** 仅在进程内使用的 32 字节 AES-256 密钥。 */
  value: Buffer;
}

/** 按密钥版本读取主密钥，供密文解析器依赖。 */
interface MasterKeyProvider {
  /** 读取指定密钥版本的 32 字节主密钥。 */
  getKey(keyId: string): Promise<Buffer>;
}

/** 读取当前活动主密钥，供创建新密文的管理服务依赖。 */
interface ActiveMasterKeyProvider extends MasterKeyProvider {
  /** 返回当前用于新 AES-GCM 密文的密钥版本和密钥内容。 */
  getActiveKey(): Promise<ActiveMasterKey>;
}

export type {
  AesGcmEncryptedPayload,
  AesGcmEncryptionMetadata,
  ActiveMasterKey,
  ActiveMasterKeyProvider,
  MasterKeyProvider,
};
