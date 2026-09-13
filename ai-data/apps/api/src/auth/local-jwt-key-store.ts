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

  /** 读取已有密钥；读取不完整时拒绝使用，首次创建采用独占写入保护已有文件。 */
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
      // 独占写入可能遇到另一进程已创建的文件；以重新读取的磁盘内容作为结果。
    }
    try {
      return {
        privateKeyPem: await readFile(this.privateKeyPath, "utf8"),
        publicKeyPem: await readFile(this.publicKeyPath, "utf8"),
      };
    } catch {
      // 重读失败时尝试从落盘私钥恢复公钥；私钥仍不可读则让文件错误向上传播。
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
