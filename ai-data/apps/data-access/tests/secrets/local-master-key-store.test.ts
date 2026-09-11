import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalMasterKeyStore } from "../../src/secrets/local-master-key-store";

describe("DAS 本地主密钥库", () => {
  // BDD 场景：首次部署尚未存在密钥库；TDD 断言：生成一把 32 字节密钥，后续启动复用同一把密钥。
  it("首次初始化生成主密钥，后续实例复用", async () => {
    const directory = await mkdtemp(join(tmpdir(), "das-key-store-"));

    try {
      const firstStore = new LocalMasterKeyStore(directory);
      const firstKey = await firstStore.getActiveKey();
      const secondStore = new LocalMasterKeyStore(directory);
      const secondKey = await secondStore.getActiveKey();

      expect(firstKey.keyId).toBe(secondKey.keyId);
      expect(firstKey.value).toEqual(secondKey.value);
      expect(firstKey.value).toHaveLength(32);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // BDD 场景：密钥库已有活动密钥记录但密钥文件损坏；TDD 断言：DAS 拒绝启动，绝不覆盖旧密文依赖的密钥。
  it("拒绝损坏的已有主密钥", async () => {
    const directory = await mkdtemp(join(tmpdir(), "das-key-store-"));

    try {
      const store = new LocalMasterKeyStore(directory);
      const activeKey = await store.getActiveKey();
      await writeFile(join(directory, "keys", `${activeKey.keyId}.key`), Buffer.alloc(16));

      await expect(new LocalMasterKeyStore(directory).getActiveKey()).rejects.toThrow(
        "必须为 32 字节",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
