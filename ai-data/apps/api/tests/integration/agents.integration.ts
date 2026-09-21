import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { SqlAgentRepository } from "../../src/agents/sql-agent-repository";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { agentAdmin, agentDefinition, skillFingerprint } from "../agents/agent-fixtures";

/** 每次只在随机临时库执行迁移、并发发布和组织隔离，连接配置由本地配置提供。 */
describe("SQL Server：Agent 固定版本与组织隔离", () => {
  const name = "ai_data_agents_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase;
  let database: SqlServerMetadataDatabase;
  let isCreated = false;
  let repository: SqlAgentRepository;
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
      userId: agentAdmin.userId,
      organizationId: agentAdmin.organizationId,
      organizationCode: "agents-test",
      organizationName: "Agent 测试组织",
      username: "agent-test",
      displayName: "Agent 测试用户",
      passwordHash: "test-hash",
    });
    repository = new SqlAgentRepository(database);
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (isCreated) {
        if (!/^ai_data_agents_test_[a-f0-9]{32}$/.test(name)) throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });

  it("并发首次发布只有一个成功，竞争请求得到版本冲突", async () => {
    const definition = { ...agentDefinition, agent_id: "first-publish" };
    const actions = await Promise.allSettled([
      repository.publish(agentAdmin.organizationId, definition, skillFingerprint),
      repository.publish(agentAdmin.organizationId, definition, skillFingerprint),
    ]);
    expect(actions.filter((action) => action.status === "fulfilled")).toHaveLength(1);
    expect(actions.filter((action) => action.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
    ]);
    expect((await repository.find(agentAdmin.organizationId, definition.agent_id))!.version).toBe(
      1,
    );
  });
  it("并发发布第二版只保存一个定义，重建仓储后旧版内容保持固定", async () => {
    const first = { ...agentDefinition, agent_id: "versioned" };
    await repository.publish(agentAdmin.organizationId, first, skillFingerprint);
    const actions = await Promise.allSettled(
      ["新说明甲", "新说明乙"].map((instructions) =>
        repository.publish(
          agentAdmin.organizationId,
          { ...first, version: 2, instructions },
          "b".repeat(64),
        ),
      ),
    );
    expect(actions.filter((action) => action.status === "fulfilled")).toHaveLength(1);
    expect(actions.filter((action) => action.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
    ]);
    const restored = new SqlAgentRepository(database);
    expect(await restored.find(agentAdmin.organizationId, first.agent_id, 1)).toMatchObject({
      ...first,
      skill_fingerprint: skillFingerprint,
    });
    expect(await restored.find(agentAdmin.organizationId, first.agent_id)).toMatchObject({
      version: 2,
      skill_fingerprint: "b".repeat(64),
    });
    await expect(
      restored.publish(agentAdmin.organizationId, { ...first, version: 4 }, skillFingerprint),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("停用状态适用于历史版本，新版本发布保持停用且可以重新启用", async () => {
    const first = { ...agentDefinition, agent_id: "status" };
    await repository.publish(agentAdmin.organizationId, first, skillFingerprint);
    expect(await repository.setEnabled(agentAdmin.organizationId, first.agent_id, false)).toBe(
      true,
    );
    expect(await repository.find(agentAdmin.organizationId, first.agent_id, 1)).toMatchObject({
      enabled: false,
    });
    expect(
      await repository.publish(
        agentAdmin.organizationId,
        { ...first, version: 2 },
        skillFingerprint,
      ),
    ).toMatchObject({ enabled: false });
    await repository.setEnabled(agentAdmin.organizationId, first.agent_id, true);
    expect(await repository.find(agentAdmin.organizationId, first.agent_id, 1)).toMatchObject({
      enabled: true,
    });
  });
  it("其他组织不能读取或启停本组织 Agent", async () => {
    const definition = { ...agentDefinition, agent_id: "scoped" };
    await repository.publish(agentAdmin.organizationId, definition, skillFingerprint);
    expect(await repository.find("other-organization", definition.agent_id)).toBeNull();
    expect(await repository.list("other-organization")).toEqual([]);
    expect(await repository.setEnabled("other-organization", definition.agent_id, false)).toBe(
      false,
    );
    expect(await repository.find(agentAdmin.organizationId, definition.agent_id)).toMatchObject({
      enabled: true,
    });
    await repository.publish(
      agentAdmin.organizationId,
      { ...definition, version: 2 },
      skillFingerprint,
    );
    expect(
      (await repository.list(agentAdmin.organizationId)).filter(
        (item) => item.agent_id === definition.agent_id,
      ),
    ).toEqual([expect.objectContaining({ agent_id: definition.agent_id, version: 2 })]);
  });
  it("同一版本不允许改写，失败操作不改变已保存指令", async () => {
    const definition = { ...agentDefinition, agent_id: "immutable" };
    await repository.publish(agentAdmin.organizationId, definition, skillFingerprint);
    await expect(
      repository.publish(
        agentAdmin.organizationId,
        { ...definition, instructions: "变化" },
        skillFingerprint,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repository.find(agentAdmin.organizationId, definition.agent_id, 1)).toMatchObject({
      instructions: definition.instructions,
    });
  });
});
