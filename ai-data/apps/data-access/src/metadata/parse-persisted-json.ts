import type { z } from "zod";

/** 解析 JSON 配置列，并用对应 Schema 拒绝损坏或人工误改的记录。 */
function parsePersistedJson<T>(json: string, schema: z.ZodType<T>, fieldName: string): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${fieldName} 不是合法 JSON: ${message}`, { cause: error });
  }

  return schema.parse(parsed);
}

export { parsePersistedJson };
