import { createHash } from "node:crypto";
import dayjs from "dayjs";
import { z } from "zod";
import { stableStringify } from "@ai-data/contracts";
import type { CodexModelProviderConfig } from "../harness/harness-types";
import type {
  ModelCapabilityDependencies,
  ModelCapabilityResult,
} from "./model-capabilities-types";

/** 只消费服务元数据中的实际窗口；训练窗口不参与运行预算。 */
const windowSchema = z.number().int().min(4096).max(2097152);
const recordSchema = z.record(z.string(), z.unknown());
const object = (value: unknown): Record<string, unknown> =>
  recordSchema.safeParse(value).data ?? {};
const windowValue = (value: unknown) => windowSchema.safeParse(value).data;

/** 按模型连接身份合并探测；缓存仅保存有时效的公开能力。 */
class ModelCapabilities {
  private readonly cache = new Map<string, { expires: number; result: ModelCapabilityResult }>();
  private readonly pending = new Map<string, Promise<ModelCapabilityResult>>();
  constructor(private readonly dependencies: ModelCapabilityDependencies = {}) {}

  async probe(provider: CodexModelProviderConfig): Promise<ModelCapabilityResult> {
    const key = createHash("sha256").update(stableStringify(provider)).digest("hex");
    const now = this.dependencies.now?.() ?? dayjs().valueOf();
    for (const [id, entry] of this.cache) if (entry.expires <= now) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (cached) return cached.result;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.read(provider)
      .then((result) => {
        if (result.status === "available") {
          if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, {
            result,
            expires: (this.dependencies.now?.() ?? dayjs().valueOf()) + 60000,
          });
        }
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async json(url: URL, provider: CodexModelProviderConfig): Promise<unknown> {
    const headers = new Headers(provider.headers);
    if (provider.apiKey) headers.set("authorization", `Bearer ${provider.apiKey}`);
    headers.set("accept", "application/json");
    const response = await (this.dependencies.request ?? fetch)(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.dependencies.timeoutMs ?? 3000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http_${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("invalid_response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 524288) {
          await reader.cancel();
          throw new Error("response_too_large");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  private async read(provider: CodexModelProviderConfig): Promise<ModelCapabilityResult> {
    try {
      const modelsUrl = new URL(provider.baseUrl);
      const prefix = modelsUrl.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
      modelsUrl.pathname = `${prefix}/v1/models`;
      modelsUrl.hash = "";
      const payload = object(await this.json(modelsUrl, provider));
      const candidates = Array.isArray(payload.data) ? payload.data.map(object) : [];
      const matched = candidates.filter((item) => item.id === provider.model);
      if (matched.length !== 1) return { status: "unavailable", reason: "model_not_matched" };
      const model = matched[0]!;
      const modelWindow = windowValue(object(model.meta).n_ctx);
      let propsWindow: number | undefined;
      if (["llamacpp", "llama.cpp"].includes(String(model.owned_by).toLowerCase())) {
        const propsUrl = new URL(modelsUrl);
        propsUrl.pathname = `${prefix}/props`;
        if (candidates.length > 1) propsUrl.searchParams.set("model", provider.model);
        try {
          const props = object(await this.json(propsUrl, provider));
          if (props.model_alias === provider.model)
            propsWindow = windowValue(object(props.default_generation_settings).n_ctx);
        } catch {
          /* models 已报告的实际窗口仍可独立使用。 */
        }
      }
      if (!modelWindow && !propsWindow)
        return { status: "unavailable", reason: "context_window_missing" };
      return {
        status: "available",
        contextWindow: Math.min(modelWindow ?? Infinity, propsWindow ?? Infinity),
        source: modelWindow && propsWindow ? "models+props" : modelWindow ? "models" : "props",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        status: "unavailable",
        reason: /^(http_\d{3}|response_too_large|invalid_response)$/.test(message)
          ? message
          : "request_failed",
      };
    }
  }
}

export { ModelCapabilities };
