import { describe, expect, it } from "vitest";
import { selectedResultReport } from "../../../src/features/reports/models/selected-result";
import { evidence } from "./fixtures";
describe("从对话保存单份结果", () => {
  it("仅提交所选依据和展示配置，查询及身份由服务器恢复", () => {
    const report = selectedResultReport(evidence, " 门诊趋势分析 ", "按科室汇总", {
      type: "bar",
      x: "department",
      y: "count",
    });
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.blocks).toHaveLength(1);
    expect(report.sections[0]!.blocks[0]).toMatchObject({
      evidence_ids: [evidence.evidence_id],
      type: "chart",
    });
    expect(report.title).toBe("门诊趋势分析");
    expect(report.description).toBe("按科室汇总");
    expect(report).not.toHaveProperty("sources");
    expect(report).not.toHaveProperty("user_id");
    expect(report.shared_with).toEqual([]);
  });
  it("明细表保存与空标题校验", () => {
    expect(selectedResultReport(evidence, "出院明细", "").sections[0]!.blocks[0]!.type).toBe(
      "table",
    );
    expect(() => selectedResultReport(evidence, "   ", "")).toThrow();
  });
});
