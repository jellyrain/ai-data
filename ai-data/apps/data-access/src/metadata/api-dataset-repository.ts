import { z } from "zod";

import type { MetadataQueryExecutor } from "@ai-data/metadata";
import {
  apiDatasetFieldMappingSchema,
  apiDatasetMappingRowSchema,
  apiRequestParameterMappingSchema,
  parsePersistedJson,
  type ApiDatasetMapping,
} from "./metadata-records";

/** 读取管理员配置的 HTTP API 虚拟表定义，原始 URL、认证信息和 JSONPath 不会离开连接器内部。 */
class ApiDatasetRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 按 source_id 与 object_id 读取一张 HTTP API 虚拟表。 */
  async findBySourceIdAndObjectId(
    sourceId: string,
    objectId: string,
  ): Promise<ApiDatasetMapping | undefined> {
    const result = await this.executor.execute({
      sql: `
        SELECT
          source_id,
          object_id,
          request_method,
          request_path,
          request_parameter_mappings_json,
          response_mode,
          response_path,
          field_mappings_json
        FROM dbo.api_dataset_response_mappings
        WHERE source_id = @source_id
          AND object_id = @object_id;
      `,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "object_id", type: "string", value: objectId },
      ],
    });
    const row = result.rows[0];

    return row === undefined ? undefined : toApiDatasetMapping(row);
  }

  /** 列出一个 HTTP API 数据源的全部虚拟表定义，供连接器目录发现使用。 */
  async listBySourceId(sourceId: string): Promise<ApiDatasetMapping[]> {
    const result = await this.executor.execute({
      sql: `
        SELECT
          source_id,
          object_id,
          request_method,
          request_path,
          request_parameter_mappings_json,
          response_mode,
          response_path,
          field_mappings_json
        FROM dbo.api_dataset_response_mappings
        WHERE source_id = @source_id
        ORDER BY object_id;
      `,
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });
    return result.rows.map((row) => toApiDatasetMapping(row));
  }
}

/** 将数据库 JSON 配置列解析为 HTTP API 连接器需要的受信任虚拟表定义。 */
function toApiDatasetMapping(row: Record<string, unknown>): ApiDatasetMapping {
  const mapping = apiDatasetMappingRowSchema.parse(row);
  const parameterMappings = parsePersistedJson(
    mapping.request_parameter_mappings_json,
    z.array(apiRequestParameterMappingSchema),
    "api_dataset_response_mappings.request_parameter_mappings_json",
  );
  const fields = parsePersistedJson(
    mapping.field_mappings_json,
    z.array(apiDatasetFieldMappingSchema).min(1),
    "api_dataset_response_mappings.field_mappings_json",
  );

  return {
    sourceId: mapping.source_id,
    objectId: mapping.object_id,
    request: {
      method: mapping.request_method,
      path: mapping.request_path,
      parameterMappings,
    },
    response: {
      mode: mapping.response_mode,
      path: mapping.response_path,
      fields: fields.map((field) => ({
        name: field.name,
        jsonPath: field.json_path,
        dataType: field.data_type,
        nullable: field.nullable,
        ...(field.source_description === undefined
          ? {}
          : { sourceDescription: field.source_description }),
      })),
    },
  };
}

export { ApiDatasetRepository };
