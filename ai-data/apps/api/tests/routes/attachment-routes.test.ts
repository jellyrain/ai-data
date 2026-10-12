import Fastify from "fastify";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createApiDependencies, context } from "../support/api-fixtures";
import { registerAttachmentRoutes } from "../../src/routes/attachment-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { ApplicationError } from "../../src/errors/application-error";
import { testImage } from "../support/test-image";

it("图片上传和二进制读取使用认证边界，原始正文仅在附件路由解析", async () => {
  const api = createApiDependencies(),
    app = Fastify();
  const id = randomUUID(),
    bytes = testImage();
  const metadata = {
    attachment_id: id,
    name: "截图.png",
    mime_type: "image/png" as const,
    size_bytes: bytes.length,
    width: 64,
    height: 64,
  };
  api.attachments.upload.mockResolvedValue(metadata as never);
  api.attachments.read.mockResolvedValue({ bytes, path: "private", metadata } as never);
  api.attachments.remove.mockResolvedValue(undefined as never);
  registerContractErrorHandler(app);
  registerAttachmentRoutes(app, api.auth, api.attachments);
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/conversations/c/attachments/${id}?name=${encodeURIComponent("截图.png")}`,
      headers: { authorization: "Bearer token", "content-type": "image/png" },
      payload: bytes,
    });
    expect(response.statusCode).toBe(201);
    expect(api.attachments.upload).toHaveBeenCalledWith(
      context,
      "c",
      id,
      "截图.png",
      "image/png",
      bytes,
    );
    const image = await app.inject({
      method: "GET",
      url: `/attachments/${id}`,
      headers: { authorization: "Bearer token" },
    });
    expect(image.rawPayload).toEqual(bytes);
    expect(image.headers["cache-control"]).toBe("private, no-store");
    expect(image.body).not.toContain("private");
    const removed = await app.inject({
      method: "DELETE",
      url: `/attachments/${id}`,
      headers: { authorization: "Bearer token" },
    });
    expect(removed.statusCode).toBe(204);
    api.auth.loadContext.mockRejectedValue(new ApplicationError("AUTHENTICATION_FAILED", "请登录"));
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/attachments/${id}`,
          headers: { authorization: "Bearer invalid" },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
