import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/** 将 Node.js 回调式 scrypt 转为可等待的密码派生函数。 */
const scrypt = promisify(scryptCallback);
/** 密码派生结果长度，单位为字节。 */
const keyLength = 64;

/** 使用独立的 16 字节随机盐派生密码摘要，按 scrypt$盐$摘要保存编码结果。 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, keyLength)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

/** 按保存的盐和摘要长度重新派生密码值，再使用时序安全比较；不支持的编码返回 false。 */
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, saltText, hashText] = encoded.split("$");
  if (encoded.split("$")[0] !== "scrypt" || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export { hashPassword, verifyPassword };
