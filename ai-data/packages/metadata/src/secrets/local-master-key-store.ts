import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveMasterKey, ActiveMasterKeyProvider } from "./secret-types";

/** 服务本地文件密钥库；活动记录保存版本引用，keys 目录保存对应的原始密钥。 */
class LocalMasterKeyStore implements ActiveMasterKeyProvider {
  private readonly activeKeyPath: string;
  private readonly keysDirectory: string;
  private readonly bootstrapLockPath: string;

  constructor(private readonly keyStoreDirectory: string) {
    this.activeKeyPath = join(keyStoreDirectory, "active-key.json");
    this.keysDirectory = join(keyStoreDirectory, "keys");
    this.bootstrapLockPath = join(keyStoreDirectory, ".bootstrap.lock");
  }

  /** 优先读取活动密钥；活动记录缺失且 keys 目录无密钥文件时才尝试首次初始化。 */
  async getActiveKey(): Promise<ActiveMasterKey> {
    await mkdir(this.keyStoreDirectory, { recursive: true });
    const activeKeyId = await this.readActiveKeyId();

    if (activeKeyId !== undefined) {
      return { keyId: activeKeyId, value: await this.getKey(activeKeyId) };
    }

    await this.assertAbsentKeyStore();
    return this.bootstrapInitialKey();
  }

  /** 按版本读取已存在的主密钥，缺失或损坏时拒绝解密。 */
  async getKey(keyId: string): Promise<Buffer> {
    assertSafeKeyId(keyId);

    let key: Buffer;
    try {
      key = await readFile(join(this.keysDirectory, `${keyId}.key`));
    } catch (error) {
      if (isFileNotFound(error)) {
        throw new Error(`本地主密钥文件不存在: ${keyId}`, { cause: error });
      }
      throw error;
    }

    if (key.length !== 32) {
      throw new Error(`本地主密钥 ${keyId} 必须为 32 字节`);
    }

    return key;
  }

  /** 活动记录只接受一个 key_id；文件缺失与记录损坏分别处理，损坏时停止初始化。 */
  private async readActiveKeyId(): Promise<string | undefined> {
    let content: string;
    try {
      content = await readFile(this.activeKeyPath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error("本地主密钥活动记录不是合法 JSON");
    }

    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof (value as Record<string, unknown>).key_id !== "string"
    ) {
      throw new Error("本地主密钥活动记录格式无效");
    }

    const keyId = (value as Record<string, unknown>).key_id as string;
    assertSafeKeyId(keyId);
    return keyId;
  }

  /** 检查遗留密钥文件，避免活动记录丢失后生成新密钥掩盖原有密文的恢复需求。 */
  private async assertAbsentKeyStore(): Promise<void> {
    try {
      const entries = await readdir(this.keysDirectory);
      if (entries.length > 0) {
        throw new Error("本地主密钥活动记录缺失，拒绝生成替代密钥");
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
  }

  /** 以独占锁文件串行化首次初始化，先写密钥，再写活动版本引用。 */
  private async bootstrapInitialKey(): Promise<ActiveMasterKey> {
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(this.bootstrapLockPath, "wx", 0o600);
    } catch (error) {
      if (!isFileAlreadyExists(error)) {
        throw error;
      }
      return this.waitForActiveKey();
    }

    try {
      // 取得锁后重新读取活动记录，复用其他初始化者可能已经写入的版本。
      const existingKeyId = await this.readActiveKeyId();
      if (existingKeyId !== undefined) {
        return { keyId: existingKeyId, value: await this.getKey(existingKeyId) };
      }

      await this.assertAbsentKeyStore();
      await mkdir(this.keysDirectory, { recursive: true });
      const keyId = randomUUID();
      const value = randomBytes(32);
      await writeFile(join(this.keysDirectory, `${keyId}.key`), value, { flag: "wx", mode: 0o600 });
      await writeFile(this.activeKeyPath, JSON.stringify({ key_id: keyId }), {
        flag: "wx",
        mode: 0o600,
      });
      return { keyId, value };
    } finally {
      await lock.close();
      await removeBootstrapLock(this.bootstrapLockPath);
    }
  }

  /** 每隔 100 毫秒读取活动记录，最多尝试 50 次；等待超时后由调用方处理启动失败。 */
  private async waitForActiveKey(): Promise<ActiveMasterKey> {
    for (let attempts = 0; attempts < 50; attempts += 1) {
      const keyId = await this.readActiveKeyId();
      if (keyId !== undefined) {
        return { keyId, value: await this.getKey(keyId) };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("本地主密钥库初始化未完成");
  }
}

/** 只接受可安全拼入密钥文件名的版本标识。 */
function assertSafeKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) {
    throw new Error("key_id 必须是安全密钥标识");
  }
}

/** 判断文件读取失败是否由文件不存在引起。 */
function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** 识别独占创建时路径已存在的错误，交由等待活动记录的分支处理。 */
function isFileAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** 删除仅用于首次初始化互斥的锁文件。 */
async function removeBootstrapLock(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }
}

export { LocalMasterKeyStore };
