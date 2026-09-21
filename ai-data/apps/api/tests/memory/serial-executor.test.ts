import { describe, expect, it, vi } from "vitest";
import { serialExecutor } from "../../src/memory/serial-executor";
import type { MetadataQueryExecutor } from "@ai-data/metadata";

describe("事务授权查询串行适配", () => {
  it("前一 SQL 失败后不再启动已排队 SQL，外层事务可以安全回滚", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValue({ rows: [], rowsAffected: [] });
    const executor = serialExecutor({ execute } as MetadataQueryExecutor);
    const result = await Promise.allSettled([
      executor.execute({ sql: "a", parameters: [] }),
      executor.execute({ sql: "b", parameters: [] }),
    ]);
    expect(result.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
