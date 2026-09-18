import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiConfigSchema } from "../../src/config/api-config";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import type { SkillResources } from "../../src/skills/skill-resources";

/** 显式启用的模型验收只使用 API 当前选中的本地服务与固定执行预算。 */
function configuredDialogueHarness(
  stateDirectory: string,
  skills: SkillResources,
): CodexAnalysisHarness {
  const path = fileURLToPath(new URL("../../config/api.config.json", import.meta.url));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("本地模型验收无法读取 API 配置");
  }
  const parsed = apiConfigSchema.shape.analysis_runtime.safeParse(raw.analysis_runtime);
  if (!parsed.success || !parsed.data?.enabled)
    throw new Error("本地模型验收需要有效且已启用的 analysis_runtime 配置");
  const runtime = parsed.data;
  const selected = runtime.providers.find((provider) => provider.id === runtime.active_provider)!;
  const hostname = new URL(selected.base_url).hostname;
  const octets = hostname.split(".").map(Number);
  const privateIpv4 =
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    (octets[0] === 127 ||
      octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (!privateIpv4 && hostname !== "localhost" && hostname !== "[::1]")
    throw new Error("本地模型验收需要当前提供方使用回环地址或私有 IPv4 地址");
  return new CodexAnalysisHarness({
    provider: {
      id: selected.id,
      baseUrl: selected.base_url,
      model: selected.model,
      apiKey: selected.api_key,
      headers: selected.headers,
    },
    stateDirectory,
    contextWindow: runtime.context_window,
    skills,
    timeoutMs: Math.min(runtime.timeout_ms, 180000),
  });
}

export { configuredDialogueHarness };
