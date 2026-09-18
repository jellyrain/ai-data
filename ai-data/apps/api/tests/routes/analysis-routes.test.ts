import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { createApiDependencies } from "../support/api-fixtures";

describe("分析运行接口", () => {
  it("压缩事件和取消终态按序回放，支持前台清理压缩提示", async () => {
    const dependencies = createApiDependencies();
    dependencies.analysis.runs.get.mockResolvedValue({ status: "cancelled", sequence: 3 } as never);
    dependencies.analysis.runs.events.mockImplementation(async (_context, _id, after) =>
      after < 3
        ? [
            {
              type: "context_compaction",
              conversation_id: "c",
              analysis_run_id: "r",
              sequence: 2,
              lease_epoch: 1,
              item_id: "compact-1",
              status: "started",
              occurred_at: "2026-09-15 16:00:00",
            },
            {
              type: "run_cancelled",
              conversation_id: "c",
              analysis_run_id: "r",
              sequence: 3,
              lease_epoch: 1,
            },
          ]
        : [],
    );
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      const response = await app.inject({
        url: "/analysis-runs/r/events",
        headers: { authorization: "Bearer test", "last-event-id": "1" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("id: 2\nevent: context_compaction");
      expect(response.body).toContain("id: 3\nevent: run_cancelled");
      expect(response.body.indexOf("context_compaction")).toBeLessThan(
        response.body.indexOf("run_cancelled"),
      );
    } finally {
      await app.close();
    }
  });
  it("终态 SSE 从 Last-Event-ID 回放并返回持久化事件编号", async () => {
    const dependencies = createApiDependencies();
    dependencies.analysis.runs.get.mockResolvedValue({ status: "completed", sequence: 3 } as never);
    dependencies.analysis.runs.events.mockImplementation(async (_context, _id, after) =>
      after < 3
        ? [
            {
              type: "run_completed",
              conversation_id: "c",
              analysis_run_id: "r",
              sequence: 3,
              lease_epoch: 1,
            },
          ]
        : [],
    );
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      const result = await app.inject({
        url: "/analysis-runs/r/events",
        headers: { authorization: "Bearer test", "last-event-id": "2" },
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toContain("text/event-stream");
      expect(result.body).toContain("id: 3\nevent: run_completed");
      expect(result.body).not.toContain("id: 2");
    } finally {
      await app.close();
    }
  });
  it("无权读取的运行在打开 SSE 前被拒绝", async () => {
    const dependencies = createApiDependencies();
    const { ApplicationError } = await import("../../src/errors/application-error");
    dependencies.analysis.runs.get.mockRejectedValue(
      new ApplicationError("NOT_FOUND", "分析运行不存在"),
    );
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      expect(
        (
          await app.inject({
            url: "/analysis-runs/other/events",
            headers: { authorization: "Bearer test" },
          })
        ).statusCode,
      ).toBe(404);
      expect(dependencies.analysis.runs.events).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("取消入口使用当前用户身份，报告更新必须携带预期版本", async () => {
    const dependencies = createApiDependencies();
    dependencies.analysis.runs.cancel = vi.fn(async () => ({ status: "cancelled" }) as never);
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/analysis-runs/r/cancel",
            headers: { authorization: "Bearer test" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/reports/r",
            headers: { authorization: "Bearer test" },
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
