import { describe, expect, it, vi } from "vitest";
import { Aes256GcmSecretCipher } from "@ai-data/metadata/secrets";
import { DatabaseConnectionService } from "../../src/data-sources/database-connection-service";
import type { EncryptedDataSourceSecret } from "../../src/secrets/secret-types";

const input = {
  secret_ref: "hospital",
  connector_kind: "sqlserver",
  host: "db.test",
  port: 1433,
  user: "reader",
  password: "fixture-secret",
};
/** 真实 AES-GCM 与带修订的内存仓储，验证管理公开信息和密码保持。 */
function fixture() {
  const records = new Map<string, EncryptedDataSourceSecret>();
  const sources: { source_id: string; secret_ref: string }[] = [];
  const cipher = new Aes256GcmSecretCipher();
  const key = Buffer.alloc(32, 8);
  const repository = {
    findBySecretRef: async (id: string) => records.get(id),
    replace: async (next: EncryptedDataSourceSecret, previous?: EncryptedDataSourceSecret) => {
      if (records.get(next.secretRef) !== previous) return false;
      records.set(next.secretRef, next);
      return true;
    },
  };
  const discovery = {
    listDatabaseTargets: vi.fn(async () => [{ name: "business", connectTarget: "business" }]),
  };
  const runtime = { invalidateBySecretRef: vi.fn(async () => {}) };
  const administration = {
    secrets: async () => ({
      items: [...records.keys()].map((secret_ref) => ({
        secret_ref,
        exists: true,
        source_ids: sources.filter((s) => s.secret_ref === secret_ref).map((s) => s.source_id),
      })),
    }),
    sources: async () => ({ items: sources }),
    deleteConnection: vi.fn(async (previous: EncryptedDataSourceSecret) => {
      if (sources.some((s) => s.secret_ref === previous.secretRef))
        throw new Error("连接仍被数据源使用");
      if (records.get(previous.secretRef) !== previous) throw new Error("冲突");
      records.delete(previous.secretRef);
    }),
  };
  const service = new DatabaseConnectionService({
    repository,
    administration,
    runtime,
    discovery,
    cipher,
    keys: { getKey: async () => key, getActiveKey: async () => ({ keyId: "test", value: key }) },
  } as never);
  const decoded = () => {
    const row = records.get("hospital")!;
    return JSON.parse(
      cipher
        .decrypt({ encryptedPayload: row.encryptedPayload, metadata: row.metadata }, key)
        .toString(),
    );
  };
  return { service, records, sources, decoded, discovery, runtime };
}
describe("数据库连接独立管理", () => {
  it("新建草稿可先测试，无需名称且不会创建连接或刷新运行连接池", async () => {
    const f = fixture();
    const { secret_ref, ...draft } = input;
    void secret_ref;
    expect(await f.service.testDraft(draft)).toEqual({
      databases: [{ name: "business", connect_target: "business" }],
    });
    expect(f.records.size).toBe(0);
    expect(f.runtime.invalidateBySecretRef).not.toHaveBeenCalled();
    expect(f.discovery.listDatabaseTargets).toHaveBeenCalledWith(
      expect.objectContaining({ host: "db.test", password: "fixture-secret" }),
      {},
    );
  });
  it("编辑草稿用当前主机与选项，空密码读取原值，新密码只用于本次测试", async () => {
    const f = fixture();
    const saved = await f.service.create(input);
    const original = f.records.get("hospital");
    const draft = {
      connector_kind: "sqlserver",
      host: "draft.test",
      port: 1434,
      user: "draft-user",
      password: "",
      saved_connection: { secret_ref: "hospital", expected_revision: saved.revision },
      sqlserver_transport: { encrypt: true, trust_server_certificate: false },
    };
    await f.service.testDraft(draft);
    expect(f.discovery.listDatabaseTargets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "draft.test",
        port: 1434,
        user: "draft-user",
        password: "fixture-secret",
        sqlserver_transport: draft.sqlserver_transport,
      }),
      {},
    );
    await f.service.testDraft({ ...draft, password: "temporary" });
    expect(f.discovery.listDatabaseTargets).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: "temporary" }),
      {},
    );
    expect(f.records.get("hospital")).toBe(original);
    expect(f.decoded()).toMatchObject({ host: "db.test", password: "fixture-secret" });
  });
  it("草稿测试拒绝过期修订、错误类型和缺失密码，失败时不修改配置", async () => {
    const f = fixture();
    const saved = await f.service.create(input);
    const original = f.records.get("hospital");
    const draft = {
      connector_kind: "sqlserver",
      host: "draft.test",
      port: 1433,
      user: "reader",
      saved_connection: { secret_ref: "hospital", expected_revision: saved.revision },
    };
    await expect(
      f.service.testDraft({
        ...draft,
        saved_connection: { ...draft.saved_connection, expected_revision: "0".repeat(64) },
      }),
    ).rejects.toThrow(/冲突|更新/);
    await expect(f.service.testDraft({ ...draft, connector_kind: "mysql" })).rejects.toThrow(
      /类型/,
    );
    await expect(f.service.testDraft({ ...draft, saved_connection: undefined })).rejects.toThrow();
    expect(f.discovery.listDatabaseTargets).not.toHaveBeenCalled();
    f.discovery.listDatabaseTargets.mockRejectedValueOnce(new Error("connection failed"));
    await expect(f.service.testDraft(draft)).rejects.toThrow("connection failed");
    expect(f.records.get("hospital")).toBe(original);
  });
  it("首次读取为空，显式创建后公开类型与地址且不回传密码", async () => {
    const f = fixture();
    expect(await f.service.list()).toEqual({ items: [] });
    const created = await f.service.create(input);
    expect(created).toMatchObject({
      secret_ref: "hospital",
      connector_kind: "sqlserver",
      host: "db.test",
      source_ids: [],
    });
    expect(JSON.stringify(await f.service.list())).not.toMatch(/fixture-secret|encrypted|password/);
    expect(f.decoded().password).toBe("fixture-secret");
  });
  it("同名新建不会覆盖已保存连接", async () => {
    const f = fixture();
    await f.service.create(input);
    await expect(f.service.create({ ...input, password: "another" })).rejects.toThrow(/冲突|存在/);
    expect(f.decoded().password).toBe("fixture-secret");
  });
  it("编辑密码留空保留，显示关联源并使旧连接池失效", async () => {
    const f = fixture();
    const before = await f.service.create(input);
    f.sources.push({ source_id: "visits", secret_ref: "hospital" });
    const after = await f.service.update("hospital", {
      expected_revision: before.revision,
      host: "new.test",
      port: 1434,
      user: "reader2",
      password: "",
    });
    expect(after).toMatchObject({ host: "new.test", source_ids: ["visits"] });
    expect(f.decoded()).toMatchObject({ password: "fixture-secret", user: "reader2" });
    expect(f.runtime.invalidateBySecretRef).toHaveBeenCalledWith("hospital");
  });
  it("更换密码后旧修订不能覆盖新连接", async () => {
    const f = fixture();
    const before = await f.service.create(input);
    const update = {
      expected_revision: before.revision,
      host: "db.test",
      port: 1433,
      user: "reader",
      password: "rotated",
    };
    await f.service.update("hospital", update);
    await expect(f.service.update("hospital", { ...update, password: "stale" })).rejects.toThrow(
      /冲突|更新/,
    );
    expect(f.decoded().password).toBe("rotated");
  });
  it("数据库类型由连接固定，编辑拒绝偷偷更换类型", async () => {
    const f = fixture();
    const before = await f.service.create(input);
    await expect(
      f.service.update("hospital", {
        expected_revision: before.revision,
        host: "db.test",
        port: 3306,
        user: "reader",
        connector_kind: "mysql",
      }),
    ).rejects.toThrow();
  });
  it("测试保存的连接返回数据库目标，驱动获得原密码", async () => {
    const f = fixture();
    await f.service.create(input);
    expect(await f.service.test("hospital", {})).toEqual({
      databases: [{ name: "business", connect_target: "business" }],
    });
    expect(f.discovery.listDatabaseTargets).toHaveBeenCalledWith(
      expect.objectContaining({ password: "fixture-secret", connectorKind: "sqlserver" }),
      {},
    );
  });
  it("已关联连接拒绝删除，解除关联后按修订删除", async () => {
    const f = fixture();
    const before = await f.service.create(input);
    f.sources.push({ source_id: "disabled-source", secret_ref: "hospital" });
    await expect(
      f.service.remove("hospital", { expected_revision: before.revision }),
    ).rejects.toThrow(/使用|关联/);
    f.sources.length = 0;
    await f.service.remove("hospital", { expected_revision: before.revision });
    expect(await f.service.list()).toEqual({ items: [] });
  });
  it("旧修订不能删除已修改连接", async () => {
    const f = fixture();
    const before = await f.service.create(input);
    await f.service.update("hospital", {
      expected_revision: before.revision,
      host: "new.test",
      port: 1433,
      user: "reader",
    });
    await expect(
      f.service.remove("hospital", { expected_revision: before.revision }),
    ).rejects.toThrow(/冲突|更新/);
  });
});
