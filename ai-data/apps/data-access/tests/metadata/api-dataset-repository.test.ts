import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { ApiDatasetRepository } from "../../src/metadata/api-dataset-repository";

// 固定记录包含序列化的请求和响应映射，仓储需分别解析 JSON 并转换为连接器对象。
describe("HTTP API 虚拟表仓储", () => {
  it("读取虚拟表的请求和响应映射", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new ApiDatasetRepository(
      createExecutor(
        [
          {
            source_id: "his_api",
            object_id: "patient_visits",
            request_method: "GET",
            request_path: "/v1/visits",
            request_parameter_mappings_json:
              '[{"name":"start_date","location":"query","key":"startDate","dataType":"date","required":true,"defaultValue":"2026-09-01"}]',
            response_mode: "list",
            response_path: "$.data.records[*]",
            field_mappings_json:
              '[{"name":"patient_id","json_path":"$.patient.id","data_type":"string","nullable":false}]',
          },
        ],
        statements,
      ),
    );

    await expect(
      repository.findBySourceIdAndObjectId("his_api", "patient_visits"),
    ).resolves.toEqual({
      sourceId: "his_api",
      objectId: "patient_visits",
      request: {
        method: "GET",
        path: "/v1/visits",
        parameterMappings: [
          {
            name: "start_date",
            location: "query",
            key: "startDate",
            dataType: "date",
            required: true,
            defaultValue: "2026-09-01",
          },
        ],
      },
      response: {
        mode: "list",
        path: "$.data.records[*]",
        fields: [
          {
            name: "patient_id",
            jsonPath: "$.patient.id",
            dataType: "string",
            nullable: false,
          },
        ],
      },
    });
    expect(statements[0]?.sql).not.toContain("patient_visits");
    expect(statements[0]?.parameters).toEqual([
      { name: "source_id", type: "string", value: "his_api" },
      { name: "object_id", type: "string", value: "patient_visits" },
    ]);
  });

  it("读取单行对象响应的虚拟表定义", async () => {
    const repository = new ApiDatasetRepository(
      createExecutor([
        {
          source_id: "his_api",
          object_id: "patient_profile",
          request_method: "GET",
          request_path: "/v1/patients/profile",
          request_parameter_mappings_json: "[]",
          response_mode: "object",
          response_path: "$.data",
          field_mappings_json:
            '[{"name":"patient_id","json_path":"$.id","data_type":"string","nullable":false}]',
        },
      ]),
    );

    await expect(
      repository.findBySourceIdAndObjectId("his_api", "patient_profile"),
    ).resolves.toMatchObject({
      response: { mode: "object", path: "$.data" },
    });
  });

  it("拒绝无效的字段映射 JSON", async () => {
    const repository = new ApiDatasetRepository(
      createExecutor([
        {
          source_id: "his_api",
          object_id: "patient_visits",
          request_method: "GET",
          request_path: "/v1/visits",
          request_parameter_mappings_json: "[]",
          response_mode: "list",
          response_path: "$.data.records[*]",
          field_mappings_json: '[{"name":"patient_id"}]',
        },
      ]),
    );

    await expect(
      repository.findBySourceIdAndObjectId("his_api", "patient_visits"),
    ).rejects.toThrow();
  });
});

/** 创建返回固定持久化记录的元数据库执行器替身。 */
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
