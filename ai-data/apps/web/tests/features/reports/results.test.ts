import { describe, expect, it } from "vitest";
import { reportSections } from "../../../src/features/reports/models/results";
import { definition, execution, evidence } from "./fixtures";
describe("报表结果按来源映射", () => {
  it("多查询结果乱序仍按查询 ID 匹配，旧说明保留来源执行", () => {
    const record = structuredClone(execution);
    record.definition.queries.push({ ...record.definition.queries[0]!, query_id: "other" });
    record.results.unshift({
      query_id: "other",
      evidence: {
        ...evidence,
        evidence_id: "other-e",
        result: { ...evidence.result, rows: [{ department: "错误来源", count: 999 }] },
      },
    });
    record.definition.presentation[0]!.blocks.push({
      block_id: "old",
      type: "text",
      title: "原有说明",
      query_ids: ["visits"],
      content: "以前的结论",
      source_execution_id: "older",
    });
    const sections = reportSections(record.snapshot!, record);
    expect(sections[0]!.blocks[0]!.evidence[0]!.evidence_id).toBe("evidence");
    expect(sections[0]!.blocks.at(-1)?.sourceExecutionId).toBe("older");
  });
  it("旧快照按证据 ID 匹配，不依赖统一定义", () => {
    const snapshot = structuredClone(execution.snapshot!);
    delete snapshot.execution_id;
    delete snapshot.definition_version;
    expect(reportSections(snapshot, null)[0]!.blocks[0]!.evidence[0]!.evidence_id).toBe("evidence");
  });
  it("图表列缺失和超预算结果返回可读错误", () => {
    const record = structuredClone(execution);
    record.definition.presentation[0]!.blocks[1]!.chart!.y = "missing";
    expect(reportSections(record.snapshot!, record)[0]!.blocks[1]!.error).toContain("missing");
    record.results[0]!.evidence.result.rows = Array.from({ length: 5001 }, () => ({
      department: "内科",
      count: 1,
    }));
    expect(() => reportSections(record.snapshot!, record)).toThrow("5,000");
    expect(definition.definition.title).toBe("门诊业务月报");
  });
});
