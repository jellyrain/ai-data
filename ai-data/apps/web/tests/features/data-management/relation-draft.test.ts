import { describe, expect, it } from "vitest";
import type { CatalogRelation, RelationPublishInput } from "@ai-data/contracts";
import {
  mergeRelations,
  relationViews,
  stageRelationChange,
  rebaseRelationChanges,
} from "../../../src/features/data-management/stores/relation-draft";

const row: CatalogRelation = {
  source_id: "clinical",
  object_id: "visits",
  relation_id: "department",
  target_object_id: "departments",
  description: "就诊所属科室",
  column_pairs: [{ source_column: "department_id", target_column: "id" }],
  allowed_join_types: ["left"],
  cardinality: "many_to_one",
  enabled: true,
  version: 2,
  updated_at: "2026-10-09 12:00:00",
};
const relation = {
  relation_id: row.relation_id,
  target_object_id: row.target_object_id,
  description: row.description,
  column_pairs: row.column_pairs,
  allowed_join_types: row.allowed_join_types,
  cardinality: row.cardinality,
};
const update: RelationPublishInput["changes"][number] = {
  action: "update",
  object_id: "visits",
  expected_version: 2,
  relation: { ...relation, description: "更新科室关系" },
};

describe("关系画布变更", () => {
  it("展开入向对象时保留批准方向，刷新一层只替换该对象的关系", () => {
    const unrelated = { ...row, object_id: "reports", target_object_id: "patients" };
    expect(
      mergeRelations([unrelated, { ...row, description: "旧说明" }], {
        source_id: "clinical",
        object_id: "departments",
        outgoing: [],
        incoming: [row],
      }),
    ).toEqual([unrelated, row]);
    expect(
      mergeRelations([unrelated, row], {
        source_id: "clinical",
        object_id: "departments",
        outgoing: [],
        incoming: [],
      }),
    ).toEqual([unrelated]);
  });
  it("反复应用同一关系只形成一次修改，不同源对象允许同名关系", () => {
    const changes = stageRelationChange([update], {
      ...update,
      relation: {
        ...update.relation,
        column_pairs: [
          { source_column: "department_id", target_column: "id" },
          { source_column: "campus_id", target_column: "campus_id" },
        ],
      },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      expected_version: 2,
      relation: { column_pairs: expect.any(Array) },
    });
    expect(stageRelationChange(changes, { ...update, object_id: "reports" })).toHaveLength(2);
    const views = relationViews("clinical", [row], changes);
    expect(views[0]).toMatchObject({
      change: "update",
      relation: {
        object_id: "visits",
        target_object_id: "departments",
        column_pairs: expect.arrayContaining([
          { source_column: "campus_id", target_column: "campus_id" },
        ]),
      },
    });
  });
  it("新增、停用与已有关系合并展示，停用仍可在画布中核对", () => {
    const views = relationViews(
      "clinical",
      [row],
      [
        {
          action: "disable",
          object_id: row.object_id,
          relation_id: row.relation_id,
          expected_version: 2,
        },
        {
          action: "create",
          object_id: "reports",
          relation: { ...relation, relation_id: "details", target_object_id: "details" },
        },
      ],
    );
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ change: "disable", relation: { enabled: false } });
    expect(views[1]).toMatchObject({
      change: "create",
      relation: { object_id: "reports", enabled: true },
    });
  });
  it("核对冲突后使用最新版本，保留原字段配对和业务说明", () => {
    expect(rebaseRelationChanges([update], [{ ...row, version: 4 }])).toEqual([
      { ...update, expected_version: 4 },
    ]);
    expect(() => rebaseRelationChanges([update], [])).toThrow(/已移除/);
  });
  it("回执丢失但修改已生效时清除已完成变更，新建同标识冲突保留待处理", () => {
    expect(rebaseRelationChanges([update], [{ ...row, ...update.relation, version: 3 }])).toEqual(
      [],
    );
    const create = { action: "create" as const, object_id: "visits", relation };
    expect(rebaseRelationChanges([create], [row])).toEqual([]);
    expect(() => rebaseRelationChanges([create], [{ ...row, description: "其他人建立" }])).toThrow(
      /已存在/,
    );
  });
});
