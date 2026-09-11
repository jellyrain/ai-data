import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/** 将 Node.js 回调式 scrypt 转为可等待的密码派生函数。 */
const scrypt = promisify(scryptCallback);
/** 密码派生结果长度，单位为字节。 */
const keyLength = 64;

/** 使用 Node.js scrypt 生成可存储的密码派生值。 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, keyLength)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

/** 校验密码派生值，使用定长比较避免直接比较密文内容。 */
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, saltText, hashText] = encoded.split("$");
  if (encoded.split("$")[0] !== "scrypt" || !saltText || !hashText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export { hashPassword, verifyPassword };
