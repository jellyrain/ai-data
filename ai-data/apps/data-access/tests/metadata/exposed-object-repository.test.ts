import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { ExposedObjectRepository } from "../../src/metadata/exposed-object-repository";

// 执行器替身记录 SQL 与参数；这些用例检查读取条件和转换，不在真实数据库执行白名单替换。
describe("暴露对象仓储", () => {
  it("保存并读取管理员过程定义与可查询状态", async () => {
    const statements: MetadataStatement[] = [];
    const procedureDefinition = {
      query_parameters: [
        {
          name: "department",
          allowed_ops: ["eq"] as const,
          data_type: "string" as const,
          required: true,
        },
      ],
      columns: [{ name: "id", data_type: "integer" as const, nullable: false }],
    };
    const repository = new ExposedObjectRepository(
      createExecutor(
        [
          {
            source_id: "clinical",
            object_id: "visits",
            object_kind: "stored_procedure",
            native_schema_name: "dbo",
            native_object_name: "get_visits",
            is_discoverable: true,
            is_queryable: true,
            capabilities_json: "{}",
            procedure_definition_json: JSON.stringify(procedureDefinition),
          },
        ],
        statements,
      ),
    );
    expect(await repository.findQueryableBySourceIdAndObjectId("clinical", "visits")).toMatchObject(
      { procedureDefinition },
    );
    await repository.replaceForSource("clinical", [
      {
        sourceId: "clinical",
        objectId: "visits",
        objectKind: "stored_procedure",
        nativeSchemaName: "dbo",
        nativeObjectName: "get_visits",
        isDiscoverable: true,
        isQueryable: false,
        queryCapabilities: {},
        procedureDefinition: {
          ...procedureDefinition,
          query_parameters: [{ ...procedureDefinition.query_parameters[0], allowed_ops: ["eq"] }],
        },
      },
    ]);
    const json = statements[1]?.parameters?.find(
      (parameter) => parameter.name === "objects_json",
    )?.value;
    expect(JSON.parse(String(json))).toMatchObject([
      { is_queryable: false, procedure_definition_json: JSON.stringify(procedureDefinition) },
    ]);
  });
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
            procedure_definition_json: null,
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
