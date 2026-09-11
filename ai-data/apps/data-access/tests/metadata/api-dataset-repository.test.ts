import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { ApiDatasetRepository } from "../../src/metadata/api-dataset-repository";

describe("HTTP API 虚拟表仓储", () => {
  // BDD 场景：HTTP API 连接器需要执行已审核虚拟表；TDD 断言：仓储返回固定请求定义和字段 JSONPath 映射。
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
              '[{"name":"start_date","location":"query","key":"startDate"}]',
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
        parameterMappings: [{ name: "start_date", location: "query", key: "startDate" }],
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

  // BDD 场景：外部接口返回一个 JSON 对象而非数组；TDD 断言：虚拟表明确标记为单行对象映射，不依赖运行时猜测 JSONPath 结果类型。
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

  // BDD 场景：管理员配置了无法解析为统一表结构的字段映射；TDD 断言：连接器启动前拒绝损坏的持久化配置。
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
