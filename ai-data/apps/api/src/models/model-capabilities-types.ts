/** 模型服务公开的实际窗口；失败只保留分类原因，不记录上游正文或凭据。 */
type ModelCapabilityResult =
  | { status: "available"; contextWindow: number; source: "models" | "props" | "models+props" }
  | { status: "unavailable"; reason: string };

/** 能力探测复用已有 HTTP 客户端能力；时钟可替换以验证缓存有效期。 */
type ModelCapabilityDependencies = {
  request?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export type { ModelCapabilityResult, ModelCapabilityDependencies };
