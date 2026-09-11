import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** API 签发与校验 Access JWT 使用的一对 PEM 密钥。 */
type JwtKeyPair = {
  /** PKCS#8 编码的 RSA 私钥 PEM。 */
  privateKeyPem: string;
  /** SubjectPublicKeyInfo 编码的 RSA 公钥 PEM。 */
  publicKeyPem: string;
};

/** API 本地 JWT 密钥库；已有密钥直接读取，首次启动时自动生成 RSA-2048 密钥对。 */
class LocalJwtKeyStore {
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;

  constructor(private readonly directory: string) {
    this.privateKeyPath = join(directory, "jwt-private.pem");
    this.publicKeyPath = join(directory, "jwt-public.pem");
  }

  /** 读取本地密钥；密钥文件不进入元数据库或启动配置。 */
  async getKeyPair(): Promise<JwtKeyPair> {
    await mkdir(this.directory, { recursive: true });
    const [privateKey, publicKey] = await Promise.allSettled([
      readFile(this.privateKeyPath, "utf8"),
      readFile(this.publicKeyPath, "utf8"),
    ]);
    if (privateKey.status === "fulfilled" && publicKey.status === "fulfilled") {
      return {
        privateKeyPem: privateKey.value,
        publicKeyPem: publicKey.value,
      };
    }
    if (privateKey.status === "fulfilled" || publicKey.status === "fulfilled")
      throw new Error("API JWT 密钥文件必须同时存在");

    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    try {
      await writeFile(this.privateKeyPath, pair.privateKey, { flag: "wx", mode: 0o600 });
      await writeFile(this.publicKeyPath, pair.publicKey, { flag: "wx", mode: 0o644 });
    } catch {
      // 多实例同时首次启动时，另一实例可能已经完成创建；以下读取作为最终结果。
    }
    try {
      return {
        privateKeyPem: await readFile(this.privateKeyPath, "utf8"),
        publicKeyPem: await readFile(this.publicKeyPath, "utf8"),
      };
    } catch {
      // 私钥已由其他实例写入而公钥尚未落盘时，从同一私钥重新导出公钥。
      const privateKeyPem = await readFile(this.privateKeyPath, "utf8");
      const publicKeyPem = createPublicKey(privateKeyPem)
        .export({ type: "spki", format: "pem" })
        .toString();
      await writeFile(this.publicKeyPath, publicKeyPem, { flag: "w", mode: 0o644 });
      return { privateKeyPem, publicKeyPem };
    }
  }
}

export { LocalJwtKeyStore };
export type { JwtKeyPair };
