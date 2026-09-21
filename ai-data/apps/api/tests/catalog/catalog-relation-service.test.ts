import { describe, expect, it } from "vitest";
import { apiDatasetConfigSchema, datasetSchema, type CatalogRelation } from "@ai-data/contracts";
import { CatalogRelationService } from "../../src/catalog/catalog-relation-service";
import type { CatalogRelationRepository } from "../../src/catalog/catalog-relation-types";
import { context } from "../support/api-fixtures";

const columns = [
  { name: "id", data_type: "integer", nullable: false },
  { name: "org", data_type: "string", nullable: false },
];
const datasets = ["a", "b", "c"].map((object_id) =>
  datasetSchema.parse({ source_id: "source", object_id, name: object_id, kind: "table", columns }),
);
const relation = {
  relation_id: "to_b",
  target_object_id: "b",
  description: "复合业务键",
  allowed_join_types: ["left" as const],
  cardinality: "one_to_one" as const,
  column_pairs: [
    { source_column: "id", target_column: "id" },
    { source_column: "org", target_column: "org" },
  ],
};

/** 仓储替身以复制后提交模拟事务，失败时不改变已发布关系。 */
function setup() {
  let records: CatalogRelation[] = [];
  const configs = datasets.map((item) =>
    apiDatasetConfigSchema.parse({
      source_id: "source",
      object_id: item.object_id,
      unique_keys: [["id", "org"]],
    }),
  );
  const repository: CatalogRelationRepository = {
    list: async (sourceId) => records.filter((item) => item.source_id === sourceId),
    transaction: async (_sourceId, operation) => {
      const next = structuredClone(records);
      const result = await operation({
        list: async () => next,
        findConfig: async (objectId) => configs.find((item) => item.object_id === objectId) ?? null,
        save: async (record) => {
          const index = next.findIndex(
            (item) =>
              item.object_id === record.object_id && item.relation_id === record.relation_id,
          );
          if (index < 0) next.push(record);
          else next[index] = record;
        },
      });
      records = next;
      return result;
    },
  };
  const visible = datasets.map((dataset) => ({ dataset }));
  const service = new CatalogRelationService({
    repository,
    rawCatalog: { listRawCatalog: async () => datasets },
    catalog: { listAuthorized: async () => visible },
  });
  return { service, repository, visible, configs };
}

describe("独立批准关系与一层关系图", () => {
  it("完整返回入边与出边，关系方向及复合字段对保持原发布含义", async () => {
    const { service } = setup();
    await service.publish(context, "source", {
      changes: [
        { action: "create", object_id: "a", relation },
        {
          action: "create",
          object_id: "b",
          relation: { ...relation, relation_id: "to_c", target_object_id: "c" },
        },
      ],
    });
    const graph = await service.graph(context, "source", "b", true);
    expect(graph.incoming.map((item) => item.object_id)).toEqual(["a"]);
    expect(graph.outgoing.map((item) => item.target_object_id)).toEqual(["c"]);
    expect(graph.incoming[0].column_pairs).toHaveLength(2);
    expect(await service.find(context, "source", "b", "to_b")).toBeNull();
  });
  it("批量更新中出现版本冲突时整批回滚，遗漏关系保持当前版本", async () => {
    const { service, repository } = setup();
    await service.publish(context, "source", {
      changes: [
        { action: "create", object_id: "a", relation },
        { action: "create", object_id: "c", relation },
      ],
    });
    await expect(
      service.publish(context, "source", {
        changes: [
          {
            action: "update",
            object_id: "a",
            expected_version: 1,
            relation: { ...relation, description: "变更" },
          },
          { action: "disable", object_id: "c", relation_id: "to_b", expected_version: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.list("source")).map((item) => item.version)).toEqual([1, 1]);
    await service.publish(context, "source", {
      changes: [{ action: "disable", object_id: "a", relation_id: "to_b", expected_version: 1 }],
    });
    expect((await repository.list("source")).find((item) => item.object_id === "c")?.enabled).toBe(
      true,
    );
    expect(await service.find(context, "source", "a", "to_b")).toBeNull();
  });
  it("缺少复合唯一键证明或字段类型不匹配时拒绝发布", async () => {
    const { service } = setup();
    await expect(
      service.publish(context, "source", {
        changes: [
          {
            action: "create",
            object_id: "a",
            relation: { ...relation, column_pairs: [relation.column_pairs[0]] },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.publish(context, "source", {
        changes: [
          {
            action: "create",
            object_id: "a",
            relation: {
              ...relation,
              column_pairs: [{ source_column: "id", target_column: "org" }],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("普通图过滤不可见对象和关系字段，管理图保留完整关系", async () => {
    const { service, visible } = setup();
    await service.publish(context, "source", {
      changes: [
        { action: "create", object_id: "a", relation },
        { action: "create", object_id: "c", relation },
      ],
    });
    visible[0].dataset = { ...visible[0].dataset, columns: [visible[0].dataset.columns[0]] };
    visible.splice(2, 1);
    const user = { ...context, roles: [], permissions: [] };
    expect((await service.graph(user, "source", "b")).incoming).toEqual([]);
    expect((await service.graph(context, "source", "b", true)).incoming).toHaveLength(2);
    await expect(service.graph(user, "source", "b", true)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
