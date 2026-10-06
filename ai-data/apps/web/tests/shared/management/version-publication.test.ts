import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publishVersion } from "../../../src/shared/management/version-publication";
import { ApiError } from "../../../src/shared/http/api-error";
const schema = z.object({ id: z.string(), version: z.number(), name: z.string() }).strict();
const draft = { id: "model", version: 2, name: "模型" };
describe("版本发布结果核对", () => {
  it("写入回执不符合合同时回读目标版本，模型仍保持待核对", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...draft, version: 1 })
      .mockResolvedValueOnce({ invalid: true })
      .mockResolvedValueOnce(draft);
    const result = await publishVersion({
      request,
      path: "/api/models",
      id: "model",
      input: draft,
      schema,
      secret: true,
    });
    expect(result).toEqual({ status: "uncertain", current: draft });
    expect(request.mock.calls.at(-1)?.[0]).toBe("/api/models/model?version=2");
  });
  it("最新版本前移时不发 POST，保留原目标版本", async () => {
    const request = vi.fn().mockResolvedValue({ ...draft, version: 2 });
    const result = await publishVersion({
      request,
      path: "/api/models",
      id: "model",
      input: draft,
      schema,
      secret: true,
    });
    expect(result.status).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(1);
    expect(draft.version).toBe(2);
  });
  it("模型回执丢失后公开字段一致仍待核对，不自动重发", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...draft, version: 1 })
      .mockRejectedValueOnce(new ApiError("断网"))
      .mockResolvedValueOnce(draft);
    const result = await publishVersion({
      request,
      path: "/api/models",
      id: "model",
      input: draft,
      schema,
      secret: true,
    });
    expect(result.status).toBe("uncertain");
    expect(request.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
});
