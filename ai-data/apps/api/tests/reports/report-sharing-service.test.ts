import { describe, expect, it, vi } from "vitest";
import { ReportSharingService } from "../../src/reports/report-sharing-service";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

function setup() {
  const head = {
    organization_id: "org",
    user_id: "user",
    version: 3,
    shared_with: ["reader", "disabled", "gone"],
  };
  const getDefinition = vi.fn(async () => head);
  const getSnapshot = vi.fn(async () => ({ ...head, version: 8 }));
  const members = vi.fn(async () => [
    {
      user_id: "disabled",
      username: "disabled",
      display_name: "停用成员",
      status: "disabled" as const,
    },
    { user_id: "reader", username: "reader", display_name: "同事", status: "active" as const },
  ]);
  const candidates = vi.fn(async () => [
    { user_id: "a", username: "a", display_name: "科员" },
    { user_id: "b", username: "b", display_name: "科员" },
  ]);
  const service = new ReportSharingService({
    definitions: { get: getDefinition },
    reports: { get: getSnapshot },
    repository: { members, candidates },
  });
  return { service, head, getDefinition, getSnapshot, members, candidates };
}

describe("报表作者成员读取", () => {
  it("取最新定义基准，保持已选顺序和停用／缺失成员", async () => {
    const h = setup();
    const result = await h.service.get(context, "report");
    expect(result).toMatchObject({
      basis: "definition",
      expected_version: 3,
      owner_user_id: "user",
    });
    expect(result.members.map((member) => member.status)).toEqual([
      "active",
      "disabled",
      "unavailable",
    ]);
    expect(result.members[2]).toEqual({
      user_id: "gone",
      username: null,
      display_name: null,
      status: "unavailable",
    });
    expect(h.members).toHaveBeenCalledWith("org", ["reader", "disabled", "gone"]);
    expect(h.getDefinition).toHaveBeenCalledWith(context, "report");
    expect(h.getSnapshot).not.toHaveBeenCalled();
  });
  it("仅在定义不存在时使用快照基准，来源授权错误不降级", async () => {
    const h = setup();
    h.getDefinition.mockRejectedValueOnce(new ApplicationError("NOT_FOUND", "无定义"));
    expect(await h.service.get(context, "report")).toMatchObject({
      basis: "snapshot",
      expected_version: 8,
    });
    h.getDefinition.mockRejectedValueOnce(new ApplicationError("POLICY_REJECTED", "数据权限不足"));
    await expect(h.service.get(context, "report")).rejects.toMatchObject({
      code: "POLICY_REJECTED",
    });
    expect(h.getSnapshot).toHaveBeenCalledTimes(1);
  });
  it.each([{ userId: "reader" }, { organizationId: "other" }])(
    "非作者或其他组织不得读取成员 %j",
    async (change) => {
      const h = setup();
      const visitor = { ...context, ...change };
      await expect(h.service.get(visitor, "report")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(h.service.candidates(visitor, "report", {})).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(h.members).not.toHaveBeenCalled();
      expect(h.candidates).not.toHaveBeenCalled();
    },
  );
  it("候选额外读取一项判断下一页，搜索和作者范围传入仓储", async () => {
    const h = setup();
    expect(
      await h.service.candidates(context, "report", { search: " 科 ", limit: 1, cursor: "0" }),
    ).toEqual({
      items: [{ user_id: "a", username: "a", display_name: "科员" }],
      next_cursor: "a",
    });
    expect(h.candidates).toHaveBeenCalledWith("org", "user", {
      search: "科",
      limit: 2,
      cursor: "0",
    });
  });
});
