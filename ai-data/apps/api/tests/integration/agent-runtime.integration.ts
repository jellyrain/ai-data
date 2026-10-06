import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { agentDefinitionSchema } from "@ai-data/contracts";
import { createAgentConfiguration } from "../../src/agents/create-agent-configuration";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { SqlAnalysisRunRepository } from "../../src/analysis-runs/sql-analysis-run-repository";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { ConversationService } from "../../src/conversations/conversation-service";
import { context } from "../support/api-fixtures";

describe("SQL Server：Agent 管理发布与会话固定版本", () => {
  const name = "ai_data_binding_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase, database: SqlServerMetadataDatabase;
  let directory: string;
  let services: ReturnType<typeof createAgentConfiguration>;
  let conversations: ConversationService;
  let repository: SqlConversationRepository;
  let created = false;
  beforeAll(async () => {
    const raw = JSON.parse(
      readFileSync(
        process.env.SQLSERVER_TEST_CONFIG ??
          fileURLToPath(new URL("../../config/api.config.json", import.meta.url)),
        "utf8",
      ),
    );
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(
      raw.metadata_sqlserver ?? raw,
    );
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await new SqlAuthRepository(database).ensureBootstrapAdmin({
      userId: context.userId,
      organizationId: context.organizationId,
      organizationCode: "binding-test",
      organizationName: "测试组织",
      username: "admin",
      displayName: "测试管理员",
      passwordHash: "test-hash",
    });
    directory = await mkdtemp(join(tmpdir(), "agent-binding-"));
    for (const skill of ["query-analysis", "query-dsl"]) {
      await mkdir(join(directory, "source", skill), { recursive: true });
      await writeFile(
        join(directory, "source", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: 测试说明\n---\n固定版本一\n`,
      );
    }
    const config = apiConfigSchema.shape.analysis_runtime.parse({
      enabled: true,
    });
    services = createAgentConfiguration({
      database,
      config,
      startupDirectory: directory,
      skillsDirectory: join(directory, "source"),
    });
    repository = new SqlConversationRepository(database);
    conversations = new ConversationService(repository, {
      selectAgent: (ctx, id, version) => services.runtime.selectAgent(ctx, id, version),
      authorizeRun: async () => ({}),
    });
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created && /^ai_data_binding_test_[a-f0-9]{32}$/.test(name))
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
    } finally {
      await admin?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it("管理发布后重建服务保留配置版本；SQL 保存凭据密文，接口只返回公开字段", async () => {
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    expect(await services.models.list(context)).toEqual([]);
    expect(await services.agents.list(context)).toEqual([]);
    await expect(conversations.create(context, "尚未配置")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await services.models.publish(context, {
      model_id: "deployment-default",
      version: 1,
      name: "已有默认模型",
      protocol: "responses",
      base_url: "http://127.0.0.1:19000/v1",
      model: "demo",
      context_window: 32768,
      api_key: "test-only-key",
    });
    await services.agents.publish(context, {
      agent_id: "default",
      version: 1,
      name: "默认分析助手",
      model_id: "deployment-default",
      model_version: 1,
      instructions: "初始说明",
      tool_names: ["read_skill_reference"],
      skill_names: ["query-analysis", "query-dsl"],
      limits: { timeout_ms: 10000, max_tool_calls: 30, max_context_bytes: 65536 },
    });
    expect(await services.agents.list(context)).toHaveLength(1);
    expect(await services.models.get(context, "deployment-default")).toMatchObject({
      version: 1,
      has_api_key: true,
    });
    const stored = await database.execute({
      sql: "SELECT definition_json,key_id,encrypted_payload,encryption_metadata_json FROM dbo.model_configuration_versions",
      parameters: [],
    });
    expect(JSON.stringify(stored.rows)).not.toContain("test-only-key");
    expect(stored.rows[0]).toMatchObject({
      key_id: expect.any(String),
      encrypted_payload: expect.any(Buffer),
      encryption_metadata_json: expect.any(String),
    });
    expect(
      (stored.rows[0]!.encrypted_payload as Buffer).includes(Buffer.from("test-only-key")),
    ).toBe(false);
    const restarted = createAgentConfiguration({
      database,
      startupDirectory: directory,
      skillsDirectory: join(directory, "source"),
    });
    expect((await restarted.models.resolve(context, "deployment-default", 1)).apiKey).toBe(
      "test-only-key",
    );
    expect(await restarted.models.list(context)).toHaveLength(1);
    expect(await restarted.agents.list(context)).toHaveLength(1);
    expect((await services.models.resolve(context, "deployment-default", 1)).apiKey).toBe(
      "test-only-key",
    );
  });
  it("已建会话固定旧版本，新会话使用新版本，运行持久化关联可追溯", async () => {
    const first = await conversations.create(context, "旧会话");
    const old = await services.agents.get(context, "default");
    const definition = agentDefinitionSchema.parse(
      Object.fromEntries(
        Object.entries(old).filter(([name]) => !["enabled", "skill_fingerprint"].includes(name)),
      ),
    );
    await writeFile(
      join(directory, "source", "query-dsl", "SKILL.md"),
      "---\nname: query-dsl\ndescription: 新说明\n---\n固定版本二\n",
    );
    await services.agents.publish(context, {
      ...definition,
      version: 2,
      instructions: "新版说明",
      skill_names: ["query-dsl"],
    });
    const next = await conversations.create(context, "新会话");
    expect(first).toMatchObject({ agentId: "default", agentVersion: 1 });
    expect(next).toMatchObject({ agentId: "default", agentVersion: 2 });
    const run = await repository.submitMessage(
      first.id,
      context.userId,
      context.organizationId,
      "测试旧版",
      "first",
    );
    const resolved = await services.runtime.resolveRun(context, run!.analysisRun.id);
    expect(resolved.agent.version).toBe(1);
    expect(resolved.configuration.skills.readReference("query-dsl", "SKILL.md").content).toContain(
      "固定版本一",
    );
    const rows = await database.execute({
      sql: "SELECT agent_id,agent_version FROM dbo.analysis_runs WHERE id=@id",
      parameters: [{ name: "id", type: "string", value: run!.analysisRun.id }],
    });
    expect(rows.rows[0]).toEqual({ agent_id: "default", agent_version: 1 });
    expect(
      await new SqlAnalysisRunRepository(database).get(context, run!.analysisRun.id),
    ).toMatchObject({ agent_id: "default", agent_version: 1 });
    await expect(
      services.runtime.resolveRun({ ...context, userId: "other" }, run!.analysisRun.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await repository.findConversation(first.id, context.userId, context.organizationId),
    ).toMatchObject({ agentId: "default", agentVersion: 1 });
  });
  it("旧会话首次执行固定默认版本，后续停用 Agent 和模型均阻止执行", async () => {
    const legacy = new ConversationService(repository);
    const conversation = await legacy.create(context, "历史会话");
    const run = await repository.submitMessage(
      conversation.id,
      context.userId,
      context.organizationId,
      "测试历史",
      "legacy",
    );
    await services.runtime.resolveRun(context, run!.analysisRun.id);
    expect(
      await repository.findConversation(conversation.id, context.userId, context.organizationId),
    ).toMatchObject({ agentId: "default", agentVersion: 2 });
    await services.agents.setEnabled(context, "default", false);
    await expect(services.runtime.resolveRun(context, run!.analysisRun.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await services.agents.setEnabled(context, "default", true);
    await services.models.setEnabled(context, "deployment-default", false);
    await expect(services.runtime.resolveRun(context, run!.analysisRun.id)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await services.models.setEnabled(context, "deployment-default", true);
  });
  it("模型并发版本发布只成功一次，旧认证可恢复且组织间隔离", async () => {
    const input = {
      model_id: "alternate",
      version: 1,
      name: "测试模型",
      protocol: "responses",
      base_url: "http://localhost/v1",
      model: "test",
      api_key: "credential-one",
    };
    const results = await Promise.allSettled([
      services.models.publish(context, input),
      services.models.publish(context, { ...input, api_key: "losing-credential" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const firstKey = results[0]!.status === "fulfilled" ? "credential-one" : "losing-credential";
    await services.models.publish(context, { ...input, version: 2, api_key: "credential-two" });
    expect((await services.models.resolve(context, "alternate", 1)).apiKey).toBe(firstKey);
    expect((await services.models.resolve(context, "alternate", 2)).apiKey).toBe("credential-two");
    await expect(
      services.models.get({ ...context, organizationId: "other" }, "alternate"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const versions = await database.execute({
      sql: "SELECT version,encrypted_payload FROM dbo.model_configuration_versions WHERE model_id='alternate' ORDER BY version",
      parameters: [],
    });
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2]);
    expect(JSON.stringify(versions.rows)).not.toContain("credential");
  });
});
