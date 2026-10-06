import { describe, expect, it } from "vitest";
import { reportShareCandidatesInputSchema, reportSharingSchema } from "../../src/index";

describe("报表作者分享读取合同", () => {
  it("搜索去除两端空白，默认 20 项，身份字段和越界分页拒绝", () => {
    expect(reportShareCandidatesInputSchema.parse({ search: " 科室 " })).toEqual({
      search: "科室",
      limit: 20,
    });
    for (const input of [
      { search: "字".repeat(81) },
      { limit: 101 },
      { cursor: "" },
      { user_id: "other" },
    ])
      expect(reportShareCandidatesInputSchema.safeParse(input).success).toBe(false);
  });
  it("当前分享保持基准版本与每个已选账号状态一致", () => {
    const input = {
      report_id: "r",
      basis: "definition",
      expected_version: 3,
      owner_user_id: "owner",
      shared_with: ["gone"],
      members: [{ user_id: "gone", username: null, display_name: null, status: "unavailable" }],
    };
    expect(reportSharingSchema.parse(input)).toEqual(input);
    for (const invalid of [
      { ...input, members: [] },
      { ...input, expected_version: 0 },
      { ...input, members: [{ ...input.members[0], status: "active" }] },
      { ...input, shared_with: ["gone", "gone"] },
      { ...input, token: "private" },
    ])
      expect(reportSharingSchema.safeParse(invalid).success).toBe(false);
  });
});
