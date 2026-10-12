import { z } from "zod";
import { imageAttachmentSchema } from "@ai-data/contracts";

/** 附件元数据与存储状态的 SQL 边界；时间由数据库生成。 */
const attachmentRecordSchema = z
  .object({
    id: z.uuid(),
    conversation_id: z.string().min(1),
    name: z.string(),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    size_bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["pending", "attached", "deleted"]),
  })
  .strict();

/** 仅导出消息需要的公开字段。 */
function publicAttachment(value: unknown) {
  const row = attachmentRecordSchema.parse(value);
  return imageAttachmentSchema.parse({
    attachment_id: row.id,
    name: row.name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
  });
}
export { attachmentRecordSchema, publicAttachment };
