import { describe, expect, it } from "vitest";
import { layoutRelations } from "../../../src/features/data-management/stores/relation-layout";

const closedLoop = { object_id: "report", target_object_id: "process_record" };
const main = { object_id: "report", target_object_id: "report_main" };

describe("业务关系默认布局", () => {
  it("从任一端进入时，同一关系都按源左目标右排列", () => {
    const first = layoutRelations(["report", "process_record"], [closedLoop]);
    const second = layoutRelations(["process_record", "report"], [closedLoop]);
    expect(first).toEqual(second);
    expect(first.get("report")!.x).toBeLessThan(first.get("process_record")!.x);
    expect(first.get("report")!.y).toBeLessThan(first.get("process_record")!.y);
  });
  it("一个源表的两个目标都在右侧，同层纵向分开且不受关系返回顺序影响", () => {
    const first = layoutRelations(["report", "report_main", "process_record"], [main, closedLoop]);
    const second = layoutRelations(["process_record", "report", "report_main"], [closedLoop, main]);
    expect(first).toEqual(second);
    expect(first.get("report")!.x).toBeLessThan(first.get("report_main")!.x);
    expect(first.get("report_main")!.x).toBe(first.get("process_record")!.x);
    expect(Math.abs(first.get("report_main")!.y - first.get("process_record")!.y)).toBeGreaterThan(
      200,
    );
  });
  it("展开多级关联时按完整方向分层，多条同端点关系共享节点位置", () => {
    const rows = [
      closedLoop,
      main,
      { object_id: "process_record", target_object_id: "report_main" },
    ];
    const ids = ["report_main", "process_record", "report"];
    const positions = layoutRelations(ids, rows);
    for (const row of rows)
      expect(positions.get(row.object_id)!.x).toBeLessThan(positions.get(row.target_object_id)!.x);
    expect(layoutRelations(ids, [...rows, closedLoop])).toEqual(positions);
  });
  it("预览和编辑使用各自节点间距，但保持相同的左右层次和上下顺序", () => {
    const ids = ["report", "process_record", "report_main"];
    const preview = layoutRelations(ids, [main, closedLoop], { x: 300, y: 140 });
    const editor = layoutRelations(ids, [main, closedLoop]);
    for (const id of ids) {
      expect(preview.get(id)!.x / 300).toBe(editor.get(id)!.x / 440);
      expect(preview.get(id)!.y / 140).toBe(editor.get(id)!.y / 260);
    }
  });
  it("未关联对象保持添加顺序独立摆放，范围外关系不产生额外节点", () => {
    const positions = layoutRelations(["report", "process_record"], [main]);
    expect(positions.size).toBe(2);
    expect(positions.get("report")!.x).toBeLessThan(positions.get("process_record")!.x);
    expect(layoutRelations([], [])).toEqual(new Map());
  });
  it("已有环形关系和自关联能稳定排布并保留全部节点", () => {
    const rows = [
      closedLoop,
      { object_id: "process_record", target_object_id: "report" },
      { object_id: "report", target_object_id: "report" },
    ];
    const positions = layoutRelations(["report", "process_record"], rows);
    expect(positions).toEqual(layoutRelations(["process_record", "report"], [...rows].reverse()));
    expect(positions.size).toBe(2);
    expect([...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(
      true,
    );
    expect(positions.get("report")).not.toEqual(positions.get("process_record"));
  });
});
