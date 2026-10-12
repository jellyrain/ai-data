import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { loadApiConfig } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { SqlConversationRepository } from "../../src/conversations/sql-conversation-repository";
import { SqlAttachmentRepository } from "../../src/conversations/sql-attachment-repository";
import { AttachmentService } from "../../src/conversations/attachment-service";
import { ConversationService } from "../../src/conversations/conversation-service";
import { SqlRuntimeRepository } from "../../src/runtime/sql-runtime-repository";
import { context } from "../support/api-fixtures";
import { testImage } from "../support/test-image";

describe("SQL 图片附件与消息原子提交", () => {
  const name = `ai_data_images_test_${randomUUID().replaceAll("-", "")}`;
  const parent = resolve("secrets");
  let admin: SqlServerMetadataDatabase, database: SqlServerMetadataDatabase, directory: string;
  let conversations: ConversationService, attachments: AttachmentService;
  let created = false;
  beforeAll(async () => {
    const config = loadApiConfig(
      fileURLToPath(new URL("../../config/api.config.json", import.meta.url)),
    );
    admin = await SqlServerMetadataDatabase.connect({
      ...config.metadata_sqlserver,
      database: "master",
    });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({
      ...config.metadata_sqlserver,
      database: name,
    });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await new SqlAuthRepository(database).ensureBootstrapAdmin({
      userId: context.userId,
      organizationId: context.organizationId,
      organizationCode: "image-test",
      organizationName: "图片测试",
      username: "admin",
      displayName: "测试",
      passwordHash: "test",
    });
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, "attachments-test-"));
    attachments = new AttachmentService(new SqlAttachmentRepository(database), directory);
    conversations = new ConversationService(new SqlConversationRepository(database));
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created && /^ai_data_images_test_[a-f0-9]{32}$/.test(name))
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
    } finally {
      await admin?.close();
      if (directory) {
        assert.equal(dirname(directory), parent);
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  it("同一上传与发送重试保持唯一，多图顺序在历史和运行恢复中一致", async () => {
    const conversation = await conversations.create(context);
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      const upload = () =>
        attachments.upload(context, conversation.id, id, "截图.png", "image/png", testImage());
      expect(await upload()).toEqual(await upload());
    }
    const send = () => conversations.submitUserMessage(context, conversation.id, "", "images", ids);
    const [first, repeat] = await Promise.all([send(), send()]);
    expect(first?.message.id).toBe(repeat?.message.id);
    expect(first?.message.attachments?.map((image) => image.attachment_id)).toEqual(ids);
    expect(repeat?.message.attachments).toEqual(first?.message.attachments);
    expect((await conversations.get(context, conversation.id))?.messages[0]?.attachments).toEqual(
      first?.message.attachments,
    );
    const input = await new SqlRuntimeRepository(database).loadInput(
      context,
      first!.analysisRun.id,
    );
    expect(input.messages[0]?.attachments?.map((image) => image.attachment_id)).toEqual(ids);
    await expect(
      conversations.submitUserMessage(context, conversation.id, "", "images", [...ids].reverse()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(attachments.remove(context, ids[0]!)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("跨用户、跨组织和跨会话图片访问或引用被拒绝且消息回滚", async () => {
    const first = await conversations.create(context),
      other = await conversations.create(context),
      id = randomUUID();
    await attachments.upload(context, first.id, id, "a.png", "image/png", testImage());
    for (const identity of [
      { ...context, userId: "other" },
      { ...context, organizationId: "other" },
    ]) {
      await expect(attachments.read(identity, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        attachments.upload(identity, first.id, randomUUID(), "a.png", "image/png", testImage()),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      conversations.submitUserMessage(context, other.id, "引用", "bad", [id]),
    ).rejects.toThrow();
    expect((await conversations.get(context, other.id))?.messages).toHaveLength(0);
    expect((await attachments.read(context, id)).bytes).toEqual(testImage());
  });
  it("过期草稿不能绑定，清理移除草稿文件；软删除会话立即阻止图片读取", async () => {
    const conversation = await conversations.create(context),
      id = randomUUID();
    await attachments.upload(context, conversation.id, id, "a.png", "image/png", testImage());
    await database.execute({
      sql: "UPDATE dbo.conversation_attachments SET expires_at=DATEADD(hour,-1,SYSUTCDATETIME()) WHERE id=@id",
      parameters: [{ name: "id", type: "string", value: id }],
    });
    await expect(
      conversations.submitUserMessage(context, conversation.id, "", "expired", [id]),
    ).rejects.toThrow();
    await attachments.cleanup();
    await expect(readFile(join(directory, `${id}.image`))).rejects.toThrow();
    const next = randomUUID();
    await attachments.upload(context, conversation.id, next, "a.png", "image/png", testImage());
    await conversations.delete(context, [conversation.id]);
    await expect(attachments.read(context, next)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("损坏或缺失文件返回明确错误", async () => {
    const conversation = await conversations.create(context),
      id = randomUUID();
    await attachments.upload(context, conversation.id, id, "a.png", "image/png", testImage());
    await writeFile(join(directory, `${id}.image`), Buffer.alloc(testImage().length));
    await expect(attachments.read(context, id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await rm(join(directory, `${id}.image`));
    await expect(attachments.read(context, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("后续附件无效时绑定和消息一起回滚，合法附件仍能再次发送", async () => {
    const conversation = await conversations.create(context),
      id = randomUUID();
    await attachments.upload(context, conversation.id, id, "a.png", "image/png", testImage());
    await expect(
      conversations.submitUserMessage(context, conversation.id, "", "rollback", [id, randomUUID()]),
    ).rejects.toThrow();
    expect((await conversations.get(context, conversation.id))?.messages).toHaveLength(0);
    expect(
      (await conversations.submitUserMessage(context, conversation.id, "", "success", [id]))
        ?.message.attachments,
    ).toHaveLength(1);
  });
  it("已有首建标记的库执行附件补丁后保留旧消息，补丁可重复执行", async () => {
    const before = await database.execute({
      sql: "SELECT COUNT(*) AS count FROM dbo.conversation_messages",
      parameters: [],
    });
    // 只在本测试创建的随机隔离库中模拟尚未升级的旧结构。
    assert(/^ai_data_images_test_[a-f0-9]{32}$/.test(name));
    await database.execute({
      sql: "DROP TABLE dbo.conversation_message_attachments; DROP TABLE dbo.conversation_attachments",
      parameters: [],
    });
    const patch = await readFile(
      fileURLToPath(
        new URL("../../../../scripts/sql/add-conversation-attachments.sql", import.meta.url),
      ),
      "utf8",
    );
    await database.execute({ sql: patch, parameters: [] });
    await database.execute({ sql: patch, parameters: [] });
    const after = await database.execute({
      sql: "SELECT COUNT(*) AS count FROM dbo.conversation_messages",
      parameters: [],
    });
    expect(after.rows).toEqual(before.rows);
    const conversation = await conversations.create(context),
      id = randomUUID();
    await attachments.upload(context, conversation.id, id, "a.png", "image/png", testImage());
    expect(
      (await conversations.submitUserMessage(context, conversation.id, "", "patch", [id]))?.message
        .attachments,
    ).toHaveLength(1);
  });
});
