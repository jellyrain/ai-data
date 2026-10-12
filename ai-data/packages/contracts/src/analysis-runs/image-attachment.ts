import { z } from "zod";

/** 图片上传与单条消息共用的资源上限。 */
const imageAttachmentLimits = {
  count: 4,
  fileBytes: 10 * 1024 * 1024,
  messageBytes: 20 * 1024 * 1024,
  dimension: 8192,
  pixels: 20_000_000,
} as const;
/** 公开附件元信息，不包含服务端路径或凭据；未知字段拒绝。 */
const imageAttachmentSchema = z
  .object({
    attachment_id: z.uuid(),
    name: z.string().min(1).max(255),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    size_bytes: z.number().int().positive().max(imageAttachmentLimits.fileBytes),
    width: z.number().int().positive().max(imageAttachmentLimits.dimension),
    height: z.number().int().positive().max(imageAttachmentLimits.dimension),
  })
  .strict()
  .refine(
    (image) => image.width * image.height <= imageAttachmentLimits.pixels,
    "图片像素超过上限",
  );

export { imageAttachmentSchema, imageAttachmentLimits };
