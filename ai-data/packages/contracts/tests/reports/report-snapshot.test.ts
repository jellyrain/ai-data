import { describe, expect, it } from "vitest";
import { saveReportInputSchema } from "../../src/index";
const block = {
  block_id: "b",
  title: "结论",
  type: "text",
  evidence_ids: ["e"],
  content: "统计结论",
};
const input = {
  analysis_run_id: "run",
  title: "报告",
  sections: [{ section_id: "s", title: "结果", blocks: [block] }],
};
describe("快照展示完整性", () => {
  it("文字需要内容，章节及跨章节块标识唯一", () => {
    expect(saveReportInputSchema.safeParse(input).success).toBe(true);
    expect(
      saveReportInputSchema.safeParse({
        ...input,
        sections: [{ ...input.sections[0], blocks: [{ ...block, content: undefined }] }],
      }).success,
    ).toBe(false);
    expect(
      saveReportInputSchema.safeParse({
        ...input,
        sections: [input.sections[0], { ...input.sections[0], section_id: "s2" }],
      }).success,
    ).toBe(false);
  });
});
