import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { context, createApiDependencies } from "../support/api-fixtures";
import { ApplicationError } from "../../src/errors/application-error";

describe("修订恢复 HTTP 入口", () => {
  it("要求登录，使用可信身份，校验路径并禁止缓存", async () => {
    const dependencies = createApiDependencies();
    const binding = vi.fn(async () => ({
      report_id: "report",
      analysis_run_id: "run",
      expected_version: 2,
    }));
    Object.assign(dependencies.reporting.revisions, { binding });
    const app = await createApp(dependencies);
    try {
      expect((await app.inject("/reports/report/revisions/run")).statusCode).toBe(401);
      const headers = { authorization: "Bearer token" };
      expect(
        (await app.inject({ url: "/reports/report/revisions/run?user_id=other", headers }))
          .statusCode,
      ).toBe(400);
      const result = await app.inject({ url: "/reports/report/revisions/run", headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toEqual({
        report_id: "report",
        analysis_run_id: "run",
        expected_version: 2,
      });
      expect(binding).toHaveBeenCalledExactlyOnceWith(context, "report", "run");
      expect(dependencies.reporting.revisions.revise).not.toHaveBeenCalled();
      expect(dependencies.reporting.executions.execute).not.toHaveBeenCalled();
      binding.mockRejectedValueOnce(new ApplicationError("NOT_FOUND", "修订不存在"));
      expect((await app.inject({ url: "/reports/report/revisions/run", headers })).statusCode).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  });
});
