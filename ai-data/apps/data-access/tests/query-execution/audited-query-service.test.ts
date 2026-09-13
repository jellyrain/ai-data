import { describe, expect, it, vi } from "vitest";

import {
  AuditedQueryService,
  type QueryAuditWriter,
} from "../../src/query-execution/audited-query-service";
import { QueryPlanningError } from "../../src/query-planning/query-planner";
import { createSignedRequest } from "../support/internal-query-fixtures";

// 使用验签与执行替身独立验证审计边界；实际验签、规划和脱敏另由路由回归覆盖。
function harness() {
  const result = { columns: [], rows: [], row_count: 0, truncated: false };
  const execute = vi.fn(async () => result);
  const verify = vi.fn(async () => {});
  const write = vi.fn<QueryAuditWriter["write"]>(async () => 1);
  return {
    result,
    execute,
    verify,
    write,
    service: new AuditedQueryService({ execute }, { verify }, { write }),
  };
}

describe("查询审计执行边界", () => {
  it("成功后记录可信身份和结构摘要，审计完成后才返回结果", async () => {
    const h = harness();
    const input = createSignedRequest();
    await expect(
      h.service.execute(input, "secret-token", { correlationId: "request-1" }),
    ).resolves.toEqual(h.result);
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.write.mock.calls[0]?.[0]).toMatchObject({
      correlationId: "request-1",
      userId: input.access.user_id,
      sourceId: input.query.source_id,
      outcome: "executed",
      rowCount: 0,
    });
    expect(JSON.stringify(h.write.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(h.write.mock.calls)).not.toContain(input.signature);
  });

  it.each(["缺少令牌", "错误签名", "无效结构"])(
    "%s 只记录服务器请求标识，不信任载荷身份",
    async (scenario) => {
      const h = harness();
      if (scenario === "错误签名") h.verify.mockRejectedValueOnce(new Error("untrusted-secret"));
      const input =
        scenario === "无效结构" ? { access: { user_id: "forged-user" } } : createSignedRequest();
      await expect(
        h.service.execute(input, scenario === "缺少令牌" ? "" : "token", { correlationId: "r" }),
      ).rejects.toBeInstanceOf(Error);
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.write).toHaveBeenCalledOnce();
      expect(h.write.mock.calls[0]?.[0]).toMatchObject({
        correlationId: "r",
        outcome: "rejected",
        objectIds: [],
      });
      expect(h.write.mock.calls[0]?.[0]).not.toHaveProperty("userId");
      expect(JSON.stringify(h.write.mock.calls)).not.toContain("untrusted-secret");
    },
  );

  it.each([
    ["QUERY_TIMEOUT", "timed_out"],
    ["CANCELLED", "failed"],
    ["QUERY_LIMIT_EXCEEDED", "rejected"],
    ["INTERNAL_ERROR", "failed"],
  ])("执行 %s 时记录对应结果且不回显业务值", async (code, outcome) => {
    const h = harness();
    h.execute.mockRejectedValueOnce(Object.assign(new Error("sensitive-value"), { code }));
    await expect(
      h.service.execute(createSignedRequest(), "token", { correlationId: "r" }),
    ).rejects.toMatchObject({ code });
    expect(h.write.mock.calls[0]?.[0]).toMatchObject({ outcome, errorCode: code });
    expect(JSON.stringify(h.write.mock.calls)).not.toContain("sensitive-value");
  });

  it("白名单规划拒绝写入可信身份和拒绝分类", async () => {
    const h = harness();
    h.execute.mockRejectedValueOnce(new QueryPlanningError("private-native-object"));
    await expect(
      h.service.execute(createSignedRequest(), "token", { correlationId: "r" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_QUERY" });
    expect(h.write.mock.calls[0]?.[0]).toMatchObject({
      outcome: "rejected",
      errorCode: "UNSUPPORTED_QUERY",
    });
  });

  it("审计写入失败时不交付查询结果且只尝试一次写入", async () => {
    const h = harness();
    h.write.mockRejectedValueOnce(new Error("database-credentials"));
    await expect(
      h.service.execute(createSignedRequest(), "token", { correlationId: "r" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: "查询审计暂不可用" });
    expect(h.write).toHaveBeenCalledOnce();
  });

  it("执行返回晚到结果时取消仍然生效", async () => {
    const h = harness();
    const controller = new AbortController();
    h.execute.mockImplementationOnce(async () => {
      controller.abort();
      return h.result;
    });
    await expect(
      h.service.execute(createSignedRequest(), "token", {
        correlationId: "r",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.write.mock.calls[0]?.[0]).toMatchObject({ outcome: "failed", errorCode: "CANCELLED" });
  });
});
