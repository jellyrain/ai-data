import { describe, expect, it } from "vitest";
import type { MetadataQueryExecutor, MetadataStatement } from "@ai-data/metadata";
import { SqlAgentRepository } from "../../src/agents/sql-agent-repository";
import { agentDefinition, agentVersion, skillFingerprint } from "./agent-fixtures";

/** 已持久化行包含独立标识和版本，读取时须与 JSON 中的定义一致。 */
const savedRow = {
  agent_id: agentDefinition.agent_id,
  version: agentDefinition.version,
  definition_json: JSON.stringify(agentDefinition),
  skill_fingerprint: skillFingerprint,
  enabled: true,
};

/** 事务替身在成功后提交全部写语句；真实并发竞争由 SQL Server 用例验证。 */
function setup(
  input: { row?: Record<string, unknown>; hasAgent?: boolean; failsInsert?: boolean } = {},
) {
  const statements: MetadataStatement[] = [];
  const committed: MetadataStatement[] = [];
  const execute: MetadataQueryExecutor["execute"] = async (statement) => {
    statements.push(statement);
    if (statement.sql.startsWith("SELECT enabled"))
      return { rows: input.hasAgent ? [{ enabled: false }] : [], rowsAffected: [] } as never;
    if (statement.sql.startsWith("SELECT"))
      return { rows: input.row ? [input.row] : [], rowsAffected: [] } as never;
    if (statement.sql.startsWith("UPDATE"))
      return {
        rows: input.hasAgent ? [{ agent_id: "outpatient" }] : [],
        rowsAffected: [],
      } as never;
    if (input.failsInsert && statement.sql.startsWith("INSERT INTO dbo.agent_definitions"))
      throw new Error("版本写入失败");
    return { rows: [], rowsAffected: [1] } as never;
  };
  const database = {
    execute,
    async transaction<T>(operation: (executor: MetadataQueryExecutor) => Promise<T>) {
      const pending: MetadataStatement[] = [];
      const result = await operation({
        execute: async (statement) => {
          const result = await execute(statement);
          if (/^(INSERT|UPDATE)/.test(statement.sql)) pending.push(statement);
          return result as never;
        },
      });
      committed.push(...pending);
      return result;
    },
  };
  return { repository: new SqlAgentRepository(database), statements, committed };
}

// 前提：Agent 定义以 JSON 保存且状态独立。操作：读取或发布版本。预期：严格校验持久化数据、组织参数、连续版本及原子提交。
describe("Agent SQL 版本仓储", () => {
  it("首版定义与 Agent 启用状态在同一事务中保存", async () => {
    const { repository, committed, statements } = setup();
    await expect(
      repository.publish("hospital-a", agentDefinition, skillFingerprint),
    ).resolves.toEqual(agentVersion);
    expect(committed).toHaveLength(2);
    expect(statements[0].sql).toContain("UPDLOCK,HOLDLOCK");
    const versionWrite = committed.find((statement) =>
      statement.sql.startsWith("INSERT INTO dbo.agent_definitions"),
    )!;
    expect(
      JSON.parse(
        String(versionWrite.parameters.find((parameter) => parameter.name === "json")!.value),
      ),
    ).toEqual(agentDefinition);
    expect(versionWrite.parameters).toContainEqual({
      name: "org",
      type: "string",
      value: "hospital-a",
    });
  });
  it("发布新版本保留 Agent 已停用状态", async () => {
    const { repository, committed } = setup({
      hasAgent: true,
      row: { ...savedRow, enabled: false },
    });
    await expect(
      repository.publish("hospital-a", { ...agentDefinition, version: 2 }, skillFingerprint),
    ).resolves.toMatchObject({ version: 2, enabled: false });
    expect(committed).toHaveLength(1);
    expect(committed[0].sql).toContain("INSERT INTO dbo.agent_definitions");
  });
  it("重复和跳号版本被拒绝，已发布定义保持原值", async () => {
    const { repository, committed } = setup({ hasAgent: true, row: savedRow });
    for (const version of [1, 3])
      await expect(
        repository.publish("hospital-a", { ...agentDefinition, version }, skillFingerprint),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(committed).toEqual([]);
  });
  it("首次发布必须使用版本一", async () => {
    const { repository, committed } = setup();
    await expect(
      repository.publish("hospital-a", { ...agentDefinition, version: 2 }, skillFingerprint),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(committed).toEqual([]);
  });
  it("版本写入失败时 Agent 状态记录也回滚", async () => {
    const { repository, committed } = setup({ failsInsert: true });
    await expect(
      repository.publish("hospital-a", agentDefinition, skillFingerprint),
    ).rejects.toThrow("版本写入失败");
    expect(committed).toEqual([]);
  });
  it("读取严格定义并按当前启停状态组合指定版本", async () => {
    const { repository, statements } = setup({ row: { ...savedRow, enabled: false } });
    await expect(repository.find("hospital-a", "outpatient", 1)).resolves.toEqual({
      ...agentVersion,
      enabled: false,
    });
    expect(statements.at(-1)!.parameters).toEqual(
      expect.arrayContaining([
        { name: "org", type: "string", value: "hospital-a" },
        { name: "id", type: "string", value: "outpatient" },
        { name: "version", type: "integer", value: 1 },
      ]),
    );
    await expect(repository.list("hospital-a")).resolves.toEqual([
      { ...agentVersion, enabled: false },
    ]);
    expect(statements.at(-1)!.parameters).toEqual([
      { name: "org", type: "string", value: "hospital-a" },
    ]);
  });
  it("损坏 JSON、越界配置、标识错位及未知字段均视为内部数据故障", async () => {
    for (const row of [
      { ...savedRow, definition_json: "{" },
      { ...savedRow, definition_json: JSON.stringify({ ...agentDefinition, extra: true }) },
      { ...savedRow, definition_json: JSON.stringify({ ...agentDefinition, version: 0 }) },
      { ...savedRow, agent_id: "inpatient" },
      { ...savedRow, version: 2 },
      { ...savedRow, enabled: "true" },
    ]) {
      const { repository } = setup({ row });
      await expect(repository.find("hospital-a", "outpatient")).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
    }
  });
  it("状态更新由组织和稳定 ID 定位，返回资源是否存在", async () => {
    const { repository, statements } = setup({ hasAgent: true });
    await expect(repository.setEnabled("hospital-a", "outpatient", false)).resolves.toBe(true);
    expect(statements.at(-1)!.parameters).toEqual(
      expect.arrayContaining([
        { name: "org", type: "string", value: "hospital-a" },
        { name: "id", type: "string", value: "outpatient" },
        { name: "enabled", type: "boolean", value: false },
      ]),
    );
    await expect(setup().repository.setEnabled("other", "outpatient", false)).resolves.toBe(false);
  });
});
