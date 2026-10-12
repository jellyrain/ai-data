import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { imageAttachmentLimits, type ImageAttachment } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { attachmentRecordSchema, publicAttachment } from "./attachment-record";
import type { AttachmentRecord } from "./attachment-types";

/** 两处读取共用同一元数据投影，磁盘位置始终由 UUID 推导。 */
const attachmentColumns =
  "a.id,a.conversation_id,a.name,a.mime_type,a.size_bytes,a.width,a.height,a.sha256,a.status";
/** 附件归属由关联会话判定，锁顺序与消息提交保持一致。 */
class SqlAttachmentRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async upload(
    context: AuthContext,
    record: AttachmentRecord,
    write: () => Promise<void>,
  ): Promise<AttachmentRecord> {
    return this.database.transaction(async (executor) => {
      const owned = await executor.execute({
        sql: "SELECT id FROM dbo.conversations WITH (UPDLOCK,HOLDLOCK) WHERE id=@conversation AND user_id=@user AND organization_id=@org AND status='active'",
        parameters: [
          { name: "conversation", type: "string", value: record.conversation_id },
          { name: "user", type: "string", value: context.userId },
          { name: "org", type: "string", value: context.organizationId },
        ],
      });
      if (!owned.rows.length) throw new ApplicationError("NOT_FOUND", "会话不存在或不可用");
      const previous = await executor.execute({
        sql: `SELECT ${attachmentColumns} FROM dbo.conversation_attachments a WITH (UPDLOCK,HOLDLOCK) WHERE a.id=@id`,
        parameters: [{ name: "id", type: "string", value: record.id }],
      });
      if (previous.rows[0]) {
        const row = attachmentRecordSchema.parse(previous.rows[0]);
        if (
          row.conversation_id !== record.conversation_id ||
          row.sha256 !== record.sha256 ||
          row.name !== record.name ||
          row.status !== "pending"
        )
          throw new ApplicationError("CONFLICT", "图片上传标识已被使用，请重新添加图片");
        const valid = await this.find(context, record.id, executor);
        if (!valid) throw new ApplicationError("NOT_FOUND", "图片已过期，请重新添加");
        return row;
      }
      await write();
      await executor.execute({
        sql: "INSERT INTO dbo.conversation_attachments(id,conversation_id,name,mime_type,size_bytes,width,height,sha256,status,expires_at) VALUES(@id,@conversation,@name,@mime,@size,@width,@height,@hash,'pending',DATEADD(hour,24,SYSUTCDATETIME()))",
        parameters: [
          { name: "id", type: "string", value: record.id },
          { name: "conversation", type: "string", value: record.conversation_id },
          { name: "name", type: "string", value: record.name },
          { name: "mime", type: "string", value: record.mime_type },
          { name: "size", type: "integer", value: record.size_bytes },
          { name: "width", type: "integer", value: record.width },
          { name: "height", type: "integer", value: record.height },
          { name: "hash", type: "string", value: record.sha256 },
        ],
      });
      return record;
    });
  }
  async find(
    context: AuthContext,
    id: string,
    executor: MetadataQueryExecutor = this.database,
  ): Promise<AttachmentRecord | null> {
    const result = await executor.execute({
      sql: `SELECT ${attachmentColumns} FROM dbo.conversation_attachments a JOIN dbo.conversations c ON c.id=a.conversation_id WHERE a.id=@id AND c.user_id=@user AND c.organization_id=@org AND c.status<>'deleted' AND a.status<>'deleted' AND (a.expires_at IS NULL OR a.expires_at>SYSUTCDATETIME())`,
      parameters: [
        { name: "id", type: "string", value: id },
        { name: "user", type: "string", value: context.userId },
        { name: "org", type: "string", value: context.organizationId },
      ],
    });
    return result.rows[0] ? attachmentRecordSchema.parse(result.rows[0]) : null;
  }
  async removePending(context: AuthContext, id: string): Promise<void> {
    const result = await this.database.execute({
      sql: "UPDATE a SET status='deleted' FROM dbo.conversation_attachments a JOIN dbo.conversations c ON c.id=a.conversation_id WHERE a.id=@id AND c.user_id=@user AND c.organization_id=@org AND a.status='pending'; SELECT @@ROWCOUNT AS changed",
      parameters: [
        { name: "id", type: "string", value: id },
        { name: "user", type: "string", value: context.userId },
        { name: "org", type: "string", value: context.organizationId },
      ],
    });
    if (!Number(result.rows[0]?.changed))
      throw new ApplicationError("NOT_FOUND", "未发送图片不存在");
  }
  /** 上传与消息提交在会话锁内串行；附件行锁防止清理和绑定同时生效。 */
  async bind(
    executor: MetadataQueryExecutor,
    conversationId: string,
    messageId: string,
    ids: string[],
  ): Promise<ImageAttachment[]> {
    const images: ImageAttachment[] = [];
    for (const [position, id] of ids.entries()) {
      const result = await executor.execute({
        sql: `SELECT ${attachmentColumns} FROM dbo.conversation_attachments a WITH (UPDLOCK,HOLDLOCK) WHERE a.id=@id AND a.conversation_id=@conversation AND a.status='pending' AND a.expires_at>SYSUTCDATETIME()`,
        parameters: [
          { name: "id", type: "string", value: id },
          { name: "conversation", type: "string", value: conversationId },
        ],
      });
      if (!result.rows[0])
        throw new ApplicationError(
          "INVALID_INPUT",
          "图片不存在、已过期或不属于当前会话，请重新添加",
        );
      images.push(publicAttachment(result.rows[0]));
      await executor.execute({
        sql: "INSERT INTO dbo.conversation_message_attachments(message_id,attachment_id,position) VALUES(@message,@id,@position); UPDATE dbo.conversation_attachments SET status='attached',expires_at=NULL WHERE id=@id",
        parameters: [
          { name: "message", type: "string", value: messageId },
          { name: "id", type: "string", value: id },
          { name: "position", type: "integer", value: position },
        ],
      });
    }
    if (
      images.reduce((sum, image) => sum + image.size_bytes, 0) > imageAttachmentLimits.messageBytes
    )
      throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "每条消息图片合计不能超过 20 MB");
    return images;
  }
  async forMessages(
    executor: MetadataQueryExecutor,
    conversationId: string,
  ): Promise<Map<string, ImageAttachment[]>> {
    const result = await executor.execute({
      sql: `SELECT ma.message_id,${attachmentColumns} FROM dbo.conversation_message_attachments ma JOIN dbo.conversation_attachments a ON a.id=ma.attachment_id WHERE a.conversation_id=@conversation AND a.status='attached' ORDER BY ma.message_id,ma.position`,
      parameters: [{ name: "conversation", type: "string", value: conversationId }],
    });
    const map = new Map<string, ImageAttachment[]>();
    for (const { message_id, ...row } of result.rows) {
      const id = String(message_id);
      map.set(id, [...(map.get(id) ?? []), publicAttachment(row)]);
    }
    return map;
  }
  async expired(): Promise<string[]> {
    await this.database.execute({
      sql: "UPDATE dbo.conversation_attachments SET status='deleted' WHERE status='pending' AND expires_at<=SYSUTCDATETIME()",
      parameters: [],
    });
    const rows = await this.database.execute({
      sql: "SELECT TOP (100) id FROM dbo.conversation_attachments WHERE status='deleted' ORDER BY id",
      parameters: [],
    });
    return rows.rows.map((row) => attachmentRecordSchema.shape.id.parse(row.id));
  }
  async purge(id: string): Promise<void> {
    await this.database.execute({
      sql: "DELETE FROM dbo.conversation_attachments WHERE id=@id AND status='deleted'",
      parameters: [{ name: "id", type: "string", value: id }],
    });
  }
  async exists(id: string): Promise<boolean> {
    const result = await this.database.execute({
      sql: "SELECT id FROM dbo.conversation_attachments WHERE id=@id",
      parameters: [{ name: "id", type: "string", value: id }],
    });
    return !!result.rows.length;
  }
}
export { SqlAttachmentRepository };
