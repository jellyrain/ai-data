import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { ExposedObjectRepository } from "../../src/metadata/exposed-object-repository";

describe("暴露对象仓储", () => {
  // BDD 场景：API 请求可发现目录；TDD 断言：仓储只读取管理员标记为可发现的对象，并解析基础能力配置。
  it("列出数据源中可发现的对象白名单", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new ExposedObjectRepository(
      createExecutor(
        [
          {
            source_id: "clinical_reporting",
            object_id: "clinical.surgery_record",
            object_kind: "table",
            native_schema_name: "clinical",
            native_object_name: "surgery_record",
            is_discoverable: true,
            is_queryable: true,
            capabilities_json: '{"sortable_fields":["id"]}',
          },
        ],
        statements,
      ),
    );

    await expect(repository.listDiscoverableBySourceId("clinical_reporting")).resolves.toEqual([
      {
        sourceId: "clinical_reporting",
        objectId: "clinical.surgery_record",
        objectKind: "table",
        nativeSchemaName: "clinical",
        nativeObjectName: "surgery_record",
        isDiscoverable: true,
        isQueryable: true,
        queryCapabilities: { sortable_fields: ["id"] },
      },
    ]);
    expect(statements[0]?.sql).toContain("is_discoverable = 1");
    expect(statements[0]?.parameters).toEqual([
      { name: "source_id", type: "string", value: "clinical_reporting" },
    ]);
  });

  // BDD 场景：查询规划器要定位一个可查询的物理对象；TDD 断言：停用查询权限的对象不会通过该读取路径泄漏。
  it("按对象读取时只接受可查询白名单", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new ExposedObjectRepository(createExecutor([], statements));

    await expect(
      repository.findQueryableBySourceIdAndObjectId(
        "clinical_reporting",
        "clinical.surgery_record",
      ),
    ).resolves.toBeUndefined();
    expect(statements[0]?.sql).toContain("is_queryable = 1");
    expect(statements[0]?.parameters).toEqual([
      { name: "source_id", type: "string", value: "clinical_reporting" },
      { name: "object_id", type: "string", value: "clinical.surgery_record" },
    ]);
  });

  // BDD 场景：管理员重新勾选数据源对象；TDD 断言：仓储替换该 source_id 的完整对象白名单。
  it("替换数据源的对象白名单", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new ExposedObjectRepository(createExecutor([], statements));

    await repository.replaceForSource("clinical_reporting", [
      {
        sourceId: "clinical_reporting",
        objectId: "table.clinical.patient_records",
        objectKind: "table",
        nativeSchemaName: "clinical",
        nativeObjectName: "patient_records",
        isDiscoverable: true,
        isQueryable: true,
        queryCapabilities: {},
      },
    ]);

    expect(statements[0]?.sql).toContain("DELETE FROM dbo.exposed_source_objects");
    expect(statements[0]?.sql).toContain("OPENJSON(@objects_json)");
    expect(statements[0]?.parameters).toEqual(
      expect.arrayContaining([{ name: "source_id", type: "string", value: "clinical_reporting" }]),
    );
  });
});

/** 创建记录参数化语句的元数据库执行器替身。 */
function createExecutor(
  rows: Record<string, unknown>[],
  statements: MetadataStatement[] = [],
): MetadataQueryExecutor {
  return {
    async execute<T extends Record<string, unknown>>(
      statement: MetadataStatement,
    ): Promise<MetadataQueryResult<T>> {
      statements.push(statement);
      return { rows: rows as T[], rowsAffected: [0] };
    },
  };
}
