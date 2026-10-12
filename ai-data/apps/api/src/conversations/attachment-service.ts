import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, readFile, rm, lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import dayjs from "dayjs";
import { z } from "zod";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { inspectImage } from "./image-validation";
import { publicAttachment } from "./attachment-record";
import type { SqlAttachmentRepository } from "./sql-attachment-repository";

/** 附件目录由服务配置固定；HTTP 仅接收 UUID，不接收客户端文件路径。 */
class AttachmentService {
  private readonly directory: string;
  private cleaning?: Promise<void>;
  constructor(
    private readonly repository: SqlAttachmentRepository,
    directory: string,
  ) {
    this.directory = resolve(directory);
  }
  private path(id: string): string {
    return join(this.directory, `${z.uuid().parse(id)}.image`);
  }
  async upload(
    context: AuthContext,
    conversationId: string,
    id: string,
    name: string,
    mime: string,
    bytes: Buffer,
  ) {
    const metadata = inspectImage(bytes, mime);
    const record = {
      id: z.uuid().parse(id),
      conversation_id: conversationId,
      name: z.string().trim().min(1).max(255).parse(name),
      ...metadata,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: "pending" as const,
    };
    return publicAttachment(
      await this.repository.upload(context, record, async () => {
        await mkdir(this.directory, { recursive: true });
        const temporary = join(this.directory, `${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await rename(temporary, this.path(id));
        } finally {
          await rm(temporary, { force: true });
        }
      }),
    );
  }
  async read(context: AuthContext, id: string) {
    const record = await this.repository.find(context, id);
    if (!record) throw new ApplicationError("NOT_FOUND", "图片不存在或不可访问");
    const path = this.path(record.id);
    let bytes: Buffer;
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== record.size_bytes ||
        dirname(await realpath(path)) !== (await realpath(this.directory))
      )
        throw new Error("附件文件与元信息不一致");
      bytes = await readFile(path);
    } catch (cause) {
      throw new ApplicationError("NOT_FOUND", "图片文件缺失或不可读取，请重新添加图片", { cause });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
      throw new ApplicationError("INVALID_INPUT", "图片文件内容发生变化，请重新添加图片");
    return { bytes, path, metadata: publicAttachment(record) };
  }
  async remove(context: AuthContext, id: string): Promise<void> {
    await this.repository.removePending(context, z.uuid().parse(id));
  }
  /** 每小时及启动时处理过期草稿；已发送图片沿用会话软删除保留策略。 */
  cleanup(): Promise<void> {
    this.cleaning ??= this.sweep().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }
  private async sweep(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const id of await this.repository.expired()) {
      await rm(this.path(id), { force: true });
      await this.repository.purge(id);
    }
    // 处理写盘成功而数据库事务未提交留下的文件；24 小时后才检查，避开在途上传。
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.(image|tmp)$/.test(entry.name)) continue;
      const path = join(this.directory, entry.name),
        stat = await lstat(path);
      if (dayjs(stat.mtime).add(24, "hour").isAfter(dayjs())) continue;
      const id = entry.name.slice(0, 36);
      if (entry.name.endsWith(".tmp") || !(await this.repository.exists(id)))
        await rm(path, { force: true });
    }
  }
}
export { AttachmentService };
