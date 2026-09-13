import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Aes256GcmSecretCipher } from "../../src/secrets/aes-256-gcm-secret-cipher";

// 每次生成测试主密钥，直接验证密文往返与篡改后的认证失败。
describe("AES-256-GCM 数据源密文", () => {
  it("加密并解密数据源连接配置", () => {
    const cipher = new Aes256GcmSecretCipher();
    const key = randomBytes(32);
    const plaintext = Buffer.from('{"server":"10.0.0.15","password":"secret"}', "utf8");
    const encrypted = cipher.encrypt(plaintext, key);

    expect(cipher.decrypt(encrypted, key)).toEqual(plaintext);
  });

  it("拒绝被篡改的密文", () => {
    const cipher = new Aes256GcmSecretCipher();
    const key = randomBytes(32);
    const encrypted = cipher.encrypt(Buffer.from("secret", "utf8"), key);
    // 只翻转密文中的一个比特，保留原认证标签，使认证失败来自载荷变化。
    encrypted.encryptedPayload[0] = (encrypted.encryptedPayload[0] ?? 0) ^ 1;

    expect(() => cipher.decrypt(encrypted, key)).toThrow();
  });
});
