import { describe, expect, it, vi } from "vitest";
import { KnowledgeApi } from "../../../src/features/knowledge/api/knowledge-api";
import { PreferenceApi } from "../../../src/features/preferences/api/preference-api";
import { TaskApi } from "../../../src/features/tasks/api/task-api";

describe("知识与偏好 Web 请求边界", () => {
  it("偏好重新设置先读服务端版本，同一请求保留幂等键", async () => {
    const request = vi.fn(async () => ({ status: "deleted", version: 4 }));
    expect(await new PreferenceApi(request).editState("time/year")).toEqual({
      status: "deleted",
      version: 4,
    });
    expect(request).toHaveBeenCalledWith("/api/me/preferences/time%2Fyear/edit-state");
  });
  it("管理列表严格检查响应，额外秘密字段不能进入页面", async () => {
    const request = vi.fn(async () => ({ items: [], token: "private" }));
    await expect(new KnowledgeApi(request).management()).rejects.toThrow();
  });
  it("固定模板预览由候选入口读取，负责人搜索有界且编码关键词", async () => {
    const request = vi.fn(async () => ({
      items: [{ user_id: "u", username: "user", display_name: "用户" }],
    }));
    expect(await new KnowledgeApi(request).owners("张&李")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      "/api/admin/knowledge/owner-options?keyword=%E5%BC%A0%26%E6%9D%8E&limit=50",
    );
  });
  it("任务仅允许失败记录重试，列表拒绝私有正文", async () => {
    const request = vi.fn(async () => undefined),
      api = new TaskApi(request);
    await expect(api.retry("task", "processing")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await api.retry("task", "failed");
    expect(request).toHaveBeenCalledWith("/api/admin/memory-events/task/retry", { method: "POST" });
  });
});
