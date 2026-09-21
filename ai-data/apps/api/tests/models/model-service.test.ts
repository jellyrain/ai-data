import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelConfiguration } from "@ai-data/contracts";
import { LocalMasterKeyStore } from "@ai-data/metadata/secrets";
import { ModelService } from "../../src/models/model-service";
import { ModelCredentialCipher } from "../../src/models/model-credential-cipher";
import type { ModelRepository, StoredModel } from "../../src/models/model-types";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

const directories: string[] = [];
const parent = resolve("secrets");
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    expect(dirname(directory)).toBe(parent);
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "models-test-"));
  directories.push(directory);
  const rows = new Map<string, StoredModel[]>();
  const repository: ModelRepository = {
    async publish(org, row) {
      const key = `${org}:${row.configuration.model_id}`;
      const versions = rows.get(key) ?? [];
      if (row.configuration.version !== versions.length + 1)
        throw new ApplicationError("CONFLICT", "版本冲突");
      versions.push(row);
      rows.set(key, versions);
      return row.configuration;
    },
    async find(org, id, version) {
      const versions = rows.get(`${org}:${id}`);
      return version === undefined
        ? (versions?.at(-1) ?? null)
        : (versions?.find((row) => row.configuration.version === version) ?? null);
    },
    async list(org) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(`${org}:`))
        .map(([, values]) => values.at(-1)!.configuration);
    },
    async setEnabled(org, id, enabled) {
      const versions = rows.get(`${org}:${id}`);
      if (!versions) return false;
      for (const row of versions) row.configuration.enabled = enabled;
      return true;
    },
  };
  const credentials = new ModelCredentialCipher(new LocalMasterKeyStore(directory));
  return { service: new ModelService({ repository, credentials }), repository, rows, directory };
}
const admin = { ...context, roles: ["system_admin"] };
const input = {
  model_id: "local",
  version: 1,
  name: "本地",
  protocol: "responses",
  base_url: "http://127.0.0.1/v1",
  model: "model-a",
  api_key: "key-a",
  headers: { "x-secret": "header-a" },
};

describe("模型配置管理", () => {
  it("发布和读取时脱敏，运行时按版本取得服务端认证", async () => {
    const { service, rows } = await setup();
    const saved: ModelConfiguration = await service.publish(admin, input);
    expect(saved).toMatchObject({ has_api_key: true, header_names: ["x-secret"], enabled: true });
    // 凭据与版本一同交给仓储保存，持久化内容必须是可认证的密文。
    expect([...rows.values()][0]?.[0]).toMatchObject({
      credentials: {
        keyId: expect.any(String),
        encryptedPayload: expect.any(Buffer),
        metadata: { iv_hex: expect.any(String), auth_tag_hex: expect.any(String) },
      },
    });
    expect(JSON.stringify([...rows.values()])).not.toContain("key-a");
    expect(JSON.stringify([...rows.values()])).not.toContain("header-a");
    const payload = [...rows.values()][0]![0]!.credentials.encryptedPayload;
    expect(payload.includes(Buffer.from("key-a"))).toBe(false);
    expect(payload.includes(Buffer.from("header-a"))).toBe(false);
    expect(JSON.stringify(await service.list(admin))).not.toContain("header-a");
    expect(await service.get(admin, "local")).not.toHaveProperty("credentials");
    await service.publish(admin, { ...input, version: 2, api_key: "key-b", model: "model-b" });
    expect((await service.resolve(admin, "local", 1)).apiKey).toBe("key-a");
    expect((await service.resolve(admin, "local", 2)).apiKey).toBe("key-b");
    expect((await service.resolve(admin, "local", 1)).headers).toEqual(input.headers);
  });
  it("重建服务后只凭数据库密文和同一主密钥库恢复历史版本", async () => {
    const { service, repository, directory, rows } = await setup();
    await service.publish(admin, input);
    await service.publish(admin, { ...input, version: 2 });
    const versions = [...rows.values()][0]!;
    expect(versions[0]!.credentials.metadata.iv_hex).not.toBe(
      versions[1]!.credentials.metadata.iv_hex,
    );
    const restarted = new ModelService({
      repository,
      credentials: new ModelCredentialCipher(new LocalMasterKeyStore(directory)),
    });
    expect((await restarted.resolve(admin, "local", 1)).apiKey).toBe("key-a");
    expect((await readdir(directory)).sort()).toEqual(["active-key.json", "keys"]);
    expect(await readdir(join(directory, "keys"))).toHaveLength(1);
  });
  it("模型版本省略认证时返回无认证配置，旧版本凭据保持可用", async () => {
    const { service } = await setup();
    await service.publish(admin, input);
    const publicVersion = await service.publish(admin, {
      ...input,
      version: 2,
      api_key: undefined,
      headers: undefined,
    });
    expect(publicVersion).toMatchObject({ has_api_key: false, header_names: [] });
    expect(await service.resolve(admin, "local", 2)).toMatchObject({
      apiKey: undefined,
      headers: undefined,
    });
    expect((await service.resolve(admin, "local", 1)).apiKey).toBe("key-a");
  });
  it.each(["密文篡改", "主密钥错误", "主密钥缺失"])(
    "%s 时拒绝运行且错误不包含凭据",
    async (failure) => {
      const { service, rows, directory } = await setup();
      await service.publish(admin, input);
      const credentials = [...rows.values()][0]![0]!.credentials;
      const keyPath = join(directory, "keys", `${credentials.keyId}.key`);
      if (failure === "密文篡改") credentials.encryptedPayload[0] ^= 1;
      if (failure === "主密钥错误") await writeFile(keyPath, Buffer.alloc(32));
      if (failure === "主密钥缺失") await rm(keyPath);
      await expect(service.resolve(admin, "local", 1)).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
        message: "模型认证无法解密",
      });
      try {
        await service.resolve(admin, "local", 1);
      } catch (error) {
        expect(String(error)).not.toContain("key-a");
        expect(String(error)).not.toContain("header-a");
      }
    },
  );
  it("跨组织读取、普通用户发布、禁用模型和版本覆盖被拒绝", async () => {
    const { service } = await setup();
    await expect(
      service.publish({ ...context, roles: [], permissions: [] }, input),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await service.publish(admin, input);
    await expect(service.get({ ...admin, organizationId: "other" }, "local")).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(service.publish(admin, input)).rejects.toMatchObject({ code: "CONFLICT" });
    await service.setEnabled(admin, "local", false);
    await expect(service.resolve(admin, "local", 1)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
