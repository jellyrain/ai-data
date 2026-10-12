import { describe, expect, it } from "vitest";
import { submitMessageSchema } from "../../src/analysis-runs/analysis-run";
import { imageAttachmentSchema } from "../../src/analysis-runs/image-attachment";

describe("图片消息合同", () => {
  const id = "c19d4fd0-e155-4719-94e0-f0449adbb982";
  it("图片元信息要求完整字段，并限制格式、容量、尺寸、总像素和未知字段", () => {
    const valid = {
      attachment_id: id,
      name: "截图.png",
      mime_type: "image/png",
      size_bytes: 1024,
      width: 100,
      height: 100,
    };
    expect(imageAttachmentSchema.parse(valid)).toEqual(valid);
    for (const key of Object.keys(valid)) {
      const missing = { ...valid } as Record<string, unknown>;
      delete missing[key];
      expect(imageAttachmentSchema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { attachment_id: "invalid" },
      { name: "" },
      { mime_type: "image/svg+xml" },
      { size_bytes: 0 },
      { size_bytes: 10485761 },
      { width: 8193 },
      { height: 0 },
      { width: 5000, height: 5000 },
      { path: "private/image.png" },
    ])
      expect(imageAttachmentSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
  it("保留文字消息并接收纯图及图文消息", () => {
    expect(submitMessageSchema.parse({ content: "你好", idempotency_key: "text" }).content).toBe(
      "你好",
    );
    expect(
      submitMessageSchema.parse({ content: "", attachment_ids: [id], idempotency_key: "image" })
        .attachment_ids,
    ).toEqual([id]);
    expect(
      submitMessageSchema.parse({ content: "看看", attachment_ids: [id], idempotency_key: "mixed" })
        .content,
    ).toBe("看看");
  });
  it("拒绝空消息、重复图片、超过四张图片及未知字段", () => {
    for (const value of [
      { content: " ", attachment_ids: [] },
      { content: "看看", attachment_ids: [id, id] },
      { content: "看看", attachment_ids: Array.from({ length: 5 }, () => crypto.randomUUID()) },
      { content: "看看", attachment_ids: [id], url: "https://example.com/image.png" },
    ])
      expect(submitMessageSchema.safeParse({ ...value, idempotency_key: "key" }).success).toBe(
        false,
      );
  });
});
