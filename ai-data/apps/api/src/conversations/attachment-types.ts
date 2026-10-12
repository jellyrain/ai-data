import type { z } from "zod";
import type { attachmentRecordSchema } from "./attachment-record";
/** API 内部使用的已校验附件记录，文件以 UUID 为固定存储键。 */
type AttachmentRecord = z.infer<typeof attachmentRecordSchema>;
export type { AttachmentRecord };
