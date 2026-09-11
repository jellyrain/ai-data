import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Aes256GcmSecretCipher } from "../../src/secrets/aes-256-gcm-secret-cipher";

describe("AES-256-GCM 数据源密文", () => {
  // BDD 场景：管理员保存外部数据源凭据；TDD 断言：AES-GCM 加密后的密文可用同一主密钥恢复原始 JSON。
  it("加密并解密数据源连接配置", () => {
    const cipher = new Aes256GcmSecretCipher();
    const key = randomBytes(32);
    const plaintext = Buffer.from('{"server":"10.0.0.15","password":"secret"}', "utf8");
    const encrypted = cipher.encrypt(plaintext, key);

    expect(cipher.decrypt(encrypted, key)).toEqual(plaintext);
  });

  // BDD 场景：持久化密文或认证标签被篡改；TDD 断言：认证解密失败，不返回部分明文。
  it("拒绝被篡改的密文", () => {
    const cipher = new Aes256GcmSecretCipher();
    const key = randomBytes(32);
    const encrypted = cipher.encrypt(Buffer.from("secret", "utf8"), key);
    encrypted.encryptedPayload[0] = (encrypted.encryptedPayload[0] ?? 0) ^ 1;

    expect(() => cipher.decrypt(encrypted, key)).toThrow();
  });
});
