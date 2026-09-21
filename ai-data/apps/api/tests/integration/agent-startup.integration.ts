import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { config } from "../support/api-fixtures";

// 构建产物从临时启动目录运行，迁移、默认导入和官方进程初始化均走生产入口。
it("API 构建产物可先启动登录，再发布模型和 Agent 并创建固定版本会话", async () => {
  const name = "ai_data_startup_test_" + randomUUID().replaceAll("-", "");
  const raw = JSON.parse(
    readFileSync(
      process.env.SQLSERVER_TEST_CONFIG ??
        fileURLToPath(new URL("../../config/api.config.json", import.meta.url)),
      "utf8",
    ),
  );
  const connection = apiConfigSchema.shape.metadata_sqlserver.parse(raw.metadata_sqlserver ?? raw);
  const admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
  const root = resolve("secrets");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "agent-startup-"));
  let created = false;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("测试监听失败");
    await new Promise<void>((done, reject) =>
      listener.close((error) => (error ? reject(error) : done())),
    );
    const input = {
      ...config,
      service: { ...config.service, port: address.port },
      metadata_sqlserver: { ...connection, database: name },
      jwt: { ...config.jwt, key_directory: join(directory, "jwt") },
      bootstrap_admin: {
        organization_id: "startup-org",
        organization_code: "startup",
        organization_name: "启动测试",
        username: "startup-admin",
        display_name: "启动管理员",
        password: "test-password-only",
      },
      analysis_runtime: {
        enabled: true,
        state_directory: "state",
        skills_directory: fileURLToPath(new URL("../../../../packages/skills", import.meta.url)),
      },
    };
    const path = join(directory, "api.config.json");
    await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../dist/index.js", import.meta.url))],
      {
        cwd: directory,
        env: { ...process.env, API_CONFIG_PATH: path },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    closed = once(child, "exit");
    const base = `http://127.0.0.1:${address.port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("API 构建产物提前退出");
      try {
        const health = await fetch(base + "/health", { signal: AbortSignal.timeout(500) });
        ready = health.ok;
        await health.body?.cancel();
        if (ready) break;
      } catch {
        /* 等待应用完成迁移并监听。 */
      }
      await setTimeout(100);
    }
    expect(ready).toBe(true);
    const login = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "startup-admin", password: "test-password-only" }),
    });
    expect(login.status).toBe(200);
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const agents = await fetch(base + "/agents", { headers });
    expect(agents.status).toBe(200);
    expect(await agents.json()).toEqual({ items: [] });
    const models = await fetch(base + "/models", { headers });
    expect(await models.json()).toEqual({ items: [] });
    const publishedModel = await fetch(base + "/models", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model_id: "startup-model",
        version: 1,
        name: "启动模型",
        protocol: "responses",
        base_url: "http://127.0.0.1:1/v1",
        model: "unused",
      }),
    });
    expect(publishedModel.status).toBe(201);
    await publishedModel.body?.cancel();
    const publishedAgent = await fetch(base + "/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_id: "default",
        version: 1,
        name: "启动助手",
        model_id: "startup-model",
        model_version: 1,
        tool_names: ["read_skill_reference"],
        skill_names: ["query-dsl"],
        limits: { timeout_ms: 10000, max_tool_calls: 5, max_context_bytes: 65536 },
      }),
    });
    expect(publishedAgent.status).toBe(201);
    await publishedAgent.body?.cancel();
    const conversation = await fetch(base + "/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "启动验收" }),
    });
    expect(conversation.status).toBe(201);
    const createdConversation = (await conversation.json()) as { id: string };
    expect(createdConversation).toMatchObject({ agentId: "default", agentVersion: 1 });
    const save = await fetch(base + "/me/preferences/style", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        idempotency_key: "style",
        value: { type: "presentation", format: "table" },
      }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      status: "saved",
      preference: { key: "style", auto_apply: true },
    });
    const preferenceList = await fetch(base + "/me/preferences", { headers });
    expect(await preferenceList.json()).toMatchObject({ items: [{ key: "style" }] });
    const candidateResponse = await fetch(base + "/knowledge-candidates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotency_key: "rule",
        content: { type: "business_rule", title: "口径", body: "按已记账收入统计" },
        scope: {},
        source: { conversation_id: createdConversation.id },
      }),
    });
    expect(candidateResponse.status).toBe(201);
    const candidate = (await candidateResponse.json()) as {
      candidate_id: string;
      version: number;
      knowledge_id: string;
    };
    for (const [action, input] of [
      ["owner", { owner_id: "bootstrap-startup-org", expected_version: candidate.version }],
      ["review", { expected_version: candidate.version, decision: "approve", comment: "已核对" }],
      ["publish", { expected_version: candidate.version, effective_at: "2026-01-01 00:00:00" }],
    ] as const) {
      const response = await fetch(
        base + `/admin/knowledge-candidates/${candidate.candidate_id}/${action}`,
        { method: "POST", headers, body: JSON.stringify(input) },
      );
      expect(response.status).toBe(action === "publish" ? 201 : 200);
      await response.body?.cancel();
    }
    const knowledge = await fetch(base + "/knowledge", { headers });
    expect(await knowledge.json()).toMatchObject({
      items: [{ knowledge_id: candidate.knowledge_id, version: 1 }],
    });
    const events = await fetch(base + "/admin/memory-events", { headers });
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual({ items: [] });
  } finally {
    if (child && child.exitCode === null) child.kill();
    await closed;
    try {
      if (created) {
        assert.match(name, /^ai_data_startup_test_[a-f0-9]{32}$/, "测试库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin.close();
      assert.equal(dirname(directory), root, "测试目录超出项目范围");
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}, 30000);
