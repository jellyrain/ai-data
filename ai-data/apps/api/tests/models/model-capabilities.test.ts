import { describe, expect, it, vi } from "vitest";
import { ModelCapabilities } from "../../src/models/model-capabilities";

const provider = {
  id: "org-model-v1",
  baseUrl: "https://model.example/proxy/v1",
  model: "rj-model-v1",
  apiKey: "test-key",
};
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const model = (window?: number) => ({
  id: provider.model,
  owned_by: "llamacpp",
  meta: { n_ctx: window, n_ctx_train: 262144 },
});

describe("模型服务能力探测", () => {
  it("准确匹配模型并核对 props，使用实际窗口且保留路径前缀", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        reply({ data: [{ id: "other", meta: { n_ctx: 100000 } }, model(32768)] }),
      )
      .mockResolvedValueOnce(
        reply({ model_alias: provider.model, default_generation_settings: { n_ctx: 32768 } }),
      );
    const service = new ModelCapabilities({ request });
    expect(await service.probe(provider)).toMatchObject({
      contextWindow: 32768,
      source: "models+props",
    });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://model.example/proxy/v1/models",
      "https://model.example/proxy/props?model=rj-model-v1",
    ]);
    expect(new Headers(request.mock.calls[0][1].headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(request.mock.calls[0][1].redirect).toBe("error");
  });
  it("服务返回不一致时采用较小窗口，训练上下文不作为回退", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(reply({ data: [model(65536)] }))
      .mockResolvedValueOnce(
        reply({ model_alias: provider.model, default_generation_settings: { n_ctx: 32768 } }),
      );
    expect(await new ModelCapabilities({ request }).probe(provider)).toMatchObject({
      contextWindow: 32768,
    });
    const trainingOnly = vi
      .fn()
      .mockResolvedValueOnce(reply({ data: [model()] }))
      .mockResolvedValueOnce(reply({ default_generation_settings: {} }));
    expect(await new ModelCapabilities({ request: trainingOnly }).probe(provider)).toMatchObject({
      status: "unavailable",
    });
  });
  it("不匹配的模型不会借用另一个模型的窗口或 props", async () => {
    const request = vi.fn(async () => reply({ data: [{ id: "other", meta: { n_ctx: 65536 } }] }));
    expect(await new ModelCapabilities({ request }).probe(provider)).toMatchObject({
      status: "unavailable",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("并发探测合并，60 秒后重读且失败不使用过期窗口", async () => {
    let now = 0;
    const request = vi.fn(async () =>
      reply({ data: [{ id: provider.model, meta: { n_ctx: 32768 } }] }),
    );
    const service = new ModelCapabilities({ request, now: () => now });
    await Promise.all([service.probe(provider), service.probe(provider)]);
    await service.probe(provider);
    expect(request).toHaveBeenCalledTimes(1);
    now = 60001;
    request.mockRejectedValueOnce(new Error("offline"));
    expect(await service.probe(provider)).toMatchObject({ status: "unavailable" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([401, 404, 500])("HTTP %i 返回脱敏失败，不缓存失败响应", async (status) => {
    const request = vi.fn(async () => new Response("private upstream error", { status }));
    const service = new ModelCapabilities({ request });
    expect(await service.probe(provider)).toMatchObject({
      status: "unavailable",
      reason: `http_${status}`,
    });
    expect(JSON.stringify(await service.probe(provider))).not.toContain("private");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("没有 v1 的地址追加兼容路径，并按连接配置隔离缓存", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      reply({ data: [{ id: provider.model, meta: { n_ctx: 65536 } }] }),
    );
    const service = new ModelCapabilities({ request });
    await service.probe({ ...provider, baseUrl: "https://model.example/proxy/" });
    await service.probe({
      ...provider,
      baseUrl: "https://model.example/proxy/",
      apiKey: "another",
    });
    expect(String(request.mock.calls[0][0])).toBe("https://model.example/proxy/v1/models");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("探测超时和超大响应归类失败，不保存上游内容", async () => {
    const request = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_done, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        }),
    );
    expect(await new ModelCapabilities({ request, timeoutMs: 5 }).probe(provider)).toMatchObject({
      status: "unavailable",
      reason: "request_failed",
    });
    expect(
      await new ModelCapabilities({
        request: async () => reply({ data: [], extra: "x".repeat(524289) }),
      }).probe(provider),
    ).toMatchObject({ status: "unavailable", reason: "response_too_large" });
  });
});
