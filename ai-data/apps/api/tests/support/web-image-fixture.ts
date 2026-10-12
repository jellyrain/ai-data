import { createHash } from "node:crypto";
import type { ImageAttachment } from "@ai-data/contracts";
import type { AuthContext } from "../../src/auth/auth-types";
import type { Conversation } from "../../src/conversations/conversation-types";
import { inspectImage } from "../../src/conversations/image-validation";
import { ApplicationError } from "../../src/errors/application-error";

/** 浏览器验收使用真实图片路由和校验，存储放在该测试服务独立内存。 */
class WebImageFixture {
  private readonly items = new Map<
    string,
    {
      conversation: string;
      bytes: Buffer;
      metadata: ImageAttachment;
      hash: string;
      attached: boolean;
    }
  >();
  constructor(
    private readonly findConversation: (
      context: AuthContext,
      id: string,
    ) => Promise<Conversation | null>,
  ) {}
  async upload(
    context: AuthContext,
    conversation: string,
    id: string,
    name: string,
    mime: string,
    bytes: Buffer,
  ) {
    if (!(await this.findConversation(context, conversation)))
      throw new ApplicationError("NOT_FOUND", "会话不存在");
    const metadata = {
      attachment_id: id,
      name,
      size_bytes: bytes.length,
      ...inspectImage(bytes, mime),
    };
    const hash = createHash("sha256").update(bytes).digest("hex");
    const old = this.items.get(id);
    if (old && (old.hash !== hash || old.conversation !== conversation || old.attached))
      throw new ApplicationError("CONFLICT", "上传标识冲突");
    this.items.set(id, { conversation, bytes, metadata, hash, attached: false });
    return metadata;
  }
  async read(context: AuthContext, id: string) {
    const item = this.items.get(id);
    if (!item || !(await this.findConversation(context, item.conversation)))
      throw new ApplicationError("NOT_FOUND", "图片不存在");
    return { bytes: item.bytes, metadata: item.metadata, path: "test-only" };
  }
  async remove(context: AuthContext, id: string) {
    await this.read(context, id);
    if (this.items.get(id)?.attached) throw new ApplicationError("NOT_FOUND", "未发送图片不存在");
    this.items.delete(id);
  }
  async bind(context: AuthContext, conversation: string, ids: string[]) {
    const images: ImageAttachment[] = [];
    for (const id of ids) {
      const result = await this.read(context, id),
        item = this.items.get(id)!;
      if (item.conversation !== conversation || item.attached)
        throw new ApplicationError("INVALID_INPUT", "图片不属于会话");
      images.push(result.metadata);
    }
    for (const id of ids) this.items.get(id)!.attached = true;
    return images;
  }
  async cleanup() {}
}
export { WebImageFixture };
