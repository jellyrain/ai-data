import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { PreferenceService } from "../../src/preferences/preference-service";
import { SqlPreferenceRepository } from "../../src/preferences/sql-preference-repository";
import {
  habitInput,
  preferenceInput,
  preferenceSource,
  preferenceUser,
} from "../preferences/preference-fixtures";

/** 每次在随机隔离库验证真实 SQL 并发、事务回滚、账号隔离及进程重建后的确认。 */
describe("SQL Server：账号记忆事务与确认", () => {
  const name = "ai_data_preferences_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let isCreated = false;
  let service: PreferenceService;
  function createService() {
    return new PreferenceService({
      repository: new SqlPreferenceRepository(database),
      authorize: async () => {},
      validateSource: async () => {},
    });
  }
  beforeAll(async () => {
    const path =
      process.env.SQLSERVER_TEST_CONFIG ??
      fileURLToPath(new URL("../../config/api.config.json", import.meta.url));
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(
      raw.metadata_sqlserver ?? raw,
    );
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    isCreated = true;
    database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await new SqlAuthRepository(database).ensureBootstrapAdmin({
      userId: preferenceUser.userId,
      organizationId: preferenceUser.organizationId,
      organizationCode: "preferences-test",
      organizationName: "记忆测试组织",
      username: "preferences-test",
      displayName: "记忆测试用户",
      passwordHash: "test-hash",
    });
    service = createService();
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (isCreated) {
        if (!/^ai_data_preferences_test_[a-f0-9]{32}$/.test(name))
          throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  it("并发首次保存同一操作只写一版和一条审计，重建服务可跨会话读取", async () => {
    const input = { ...preferenceInput, key: "first", idempotency_key: "first" };
    const results = await Promise.all([
      service.save(preferenceUser, input),
      service.save(preferenceUser, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await createService().get({ ...preferenceUser, sessionId: "new-session" }, input.key),
    ).toMatchObject({ version: 1 });
    const audits = await database.execute({
      sql: "SELECT COUNT(*) AS total FROM dbo.preference_audits WHERE JSON_VALUE(record_json,'$.key')='first'",
      parameters: [],
    });
    expect(audits.rows[0]?.total).toBe(1);
  });
  it("并发确认和明确编辑只有一个能使用旧版本", async () => {
    const input = { ...preferenceInput, key: "race", idempotency_key: "race-first" };
    await service.save(preferenceUser, input);
    const proposal = await service.save(preferenceUser, {
      ...input,
      idempotency_key: "race-proposal",
      value: { type: "presentation", format: "table" },
    });
    if (proposal.status !== "confirmation_required") throw new Error("缺少确认");
    const results = await Promise.allSettled([
      createService().confirm(
        preferenceUser,
        proposal.confirmation.confirmation_id,
        true,
        "race-confirm",
      ),
      service.save(
        preferenceUser,
        { ...input, idempotency_key: "race-edit", auto_apply: false, expected_version: 1 },
        { origin: "user" },
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
    ]);
    expect(await service.get(preferenceUser, input.key)).toMatchObject({ version: 2 });
  });
  it("同一来源多次并发观察只增加一次频次，其他账号不能读取", async () => {
    const input = { ...habitInput, key: "frequency" };
    await Promise.all(
      ["frequency-1", "frequency-2"].map((key) =>
        service.observe(preferenceUser, input, preferenceSource, key),
      ),
    );
    expect(await service.get(preferenceUser, input.key)).toMatchObject({
      use_count: 1,
      version: 1,
    });
    expect(await service.list({ ...preferenceUser, userId: "other" })).toEqual([]);
    expect(await service.list({ ...preferenceUser, organizationId: "other" })).toEqual([]);
  });
  it("外层事务回滚同时撤销记忆、来源、幂等记录及审计，重试可正常保存", async () => {
    const input = { ...habitInput, key: "atomic" };
    await expect(
      database.transaction(async (executor) => {
        await service.observe(preferenceUser, input, preferenceSource, "atomic", executor);
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");
    await expect(service.get(preferenceUser, input.key)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await service.observe(preferenceUser, input, preferenceSource, "atomic")).toMatchObject({
      status: "saved",
      preference: { version: 1, use_count: 1 },
    });
  });
  it("删除标记跨重启阻止迟到任务，并保留用户显式重建能力", async () => {
    const input = { ...habitInput, key: "deleted" };
    await service.observe(preferenceUser, input, preferenceSource, "deleted-first");
    await service.delete(preferenceUser, input.key, {
      expected_version: 1,
      idempotency_key: "delete",
    });
    const restored = createService();
    await expect(
      restored.observe(
        preferenceUser,
        input,
        { ...preferenceSource, analysis_run_id: "late-run" },
        "deleted-late",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const row = await database.execute({
      sql: "SELECT preference_json FROM dbo.user_preferences WHERE preference_key='deleted'",
      parameters: [],
    });
    expect(JSON.parse(String(row.rows[0]?.preference_json))).toEqual(
      expect.objectContaining({ version: 2, deleted_at: expect.any(String) }),
    );
    expect(JSON.parse(String(row.rows[0]?.preference_json))).not.toHaveProperty("value");
    expect(
      await restored.save(
        preferenceUser,
        { ...input, idempotency_key: "deleted-recreate" },
        { origin: "user" },
      ),
    ).toMatchObject({ status: "saved", preference: { version: 3 } });
  });
  it("重建服务读取待确认项，拒绝结果幂等且不再出现在清单", async () => {
    const input = { ...preferenceInput, key: "pending-list", idempotency_key: "pending-first" };
    await service.save(preferenceUser, input);
    const result = await service.save(preferenceUser, {
      ...input,
      idempotency_key: "pending-proposal",
      value: { type: "presentation", format: "table" },
    });
    if (result.status !== "confirmation_required") throw new Error("缺少确认");
    const restored = createService();
    expect(
      (await restored.listPendingConfirmations(preferenceUser)).some(
        (item) => item.confirmation_id === result.confirmation.confirmation_id,
      ),
    ).toBe(true);
    expect(
      await restored.confirm(
        preferenceUser,
        result.confirmation.confirmation_id,
        false,
        "pending-reject",
      ),
    ).toBeNull();
    expect(
      await restored.confirm(
        preferenceUser,
        result.confirmation.confirmation_id,
        false,
        "pending-reject",
      ),
    ).toBeNull();
    expect(
      (await restored.listPendingConfirmations(preferenceUser)).some(
        (item) => item.confirmation_id === result.confirmation.confirmation_id,
      ),
    ).toBe(false);
  });
});
