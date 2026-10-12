import type { z } from "zod";
import type { imageAttachmentSchema } from "./image-attachment";
/** 消息与上传回执共用的图片元信息。 */
type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export type { ImageAttachment };
