import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalMasterKeyStore } from "../../src/secrets/local-master-key-store";

// 每个用例创建独立临时目录，并在结束后清理；复用场景让两个实例访问同一目录。
describe("服务本地主密钥库", () => {
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

  it("拒绝损坏的已有主密钥", async () => {
    const directory = await mkdtemp(join(tmpdir(), "das-key-store-"));

    try {
      const store = new LocalMasterKeyStore(directory);
      const activeKey = await store.getActiveKey();
      // 将已存在的 32 字节密钥改成 16 字节，触发长度检查而非缺失文件分支。
      await writeFile(join(directory, "keys", `${activeKey.keyId}.key`), Buffer.alloc(16));

      await expect(new LocalMasterKeyStore(directory).getActiveKey()).rejects.toThrow(
        "必须为 32 字节",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
