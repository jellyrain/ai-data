import { describe, expect, it } from "vitest";

import { CatalogService } from "../../src/catalog/catalog-service";
import type { DataSourceConnector } from "../../src/connectors/connector";
import type { DiscoveredDataset } from "../../src/connectors/connector-catalog";

// 连接器提供原始发现结果，白名单提供逻辑映射；两者由独立替身返回以核对目录交集。
describe("DAS 目录服务", () => {
  it("将数据库目录与暴露对象白名单取交集", async () => {
    const service = new CatalogService(
      createConnectorLookup("sqlserver", [
        databaseDataset("dbo", "patients"),
        databaseDataset("dbo", "internal_notes"),
      ]),
      {
        async listDiscoverableBySourceId() {
          return [
            {
              sourceId: "clinical_reporting",
              objectId: "patient_records",
              objectKind: "table",
              nativeSchemaName: "dbo",
              nativeObjectName: "patients",
              isDiscoverable: true,
              isQueryable: true,
              queryCapabilities: { sortable_fields: ["patient_id"] },
            },
          ];
        },
      },
    );

    await expect(service.listBySourceId("clinical_reporting")).resolves.toEqual([
      {
        source_id: "clinical_reporting",
        object_id: "patient_records",
        name: "patient_records",
        kind: "table",
        schema_name: "dbo",
        columns: [
          {
            name: "patient_id",
            data_type: "integer",
            nullable: false,
          },
        ],
        query_capabilities: { sortable_fields: ["patient_id"] },
        query_parameters: [],
      },
    ]);
  });

  it("返回 HTTP API 虚拟表目录", async () => {
    const service = new CatalogService(
      createConnectorLookup("http_api", [
        {
          kind: "api_dataset",
          native_object_name: "patient_visits",
          columns: [
            {
              name: "visit_id",
              data_type: "string",
              nullable: false,
            },
          ],
          query_parameters: [
            {
              name: "start_date",
              allowed_ops: ["eq"],
              data_type: "date",
              required: false,
            },
          ],
        },
      ]),
      {
        async listDiscoverableBySourceId() {
          return [];
        },
      },
    );

    await expect(service.listBySourceId("clinical_reporting")).resolves.toEqual([
      {
        source_id: "clinical_reporting",
        object_id: "patient_visits",
        name: "patient_visits",
        kind: "api_dataset",
        columns: [
          {
            name: "visit_id",
            data_type: "string",
            nullable: false,
          },
        ],
        query_parameters: [
          {
            name: "start_date",
            allowed_ops: ["eq"],
            data_type: "date",
            required: false,
          },
        ],
      },
    ]);
  });
});

/** 构造一个业务数据库发现的目录对象。 */
function databaseDataset(schema: string, name: string): DiscoveredDataset {
  return {
    kind: "table",
    native_schema_name: schema,
    native_object_name: name,
    columns: [
      {
        name: "patient_id",
        data_type: "integer",
        nullable: false,
      },
    ],
  };
}

/** 构造无需真实连接池的目录连接器读取能力。 */
function createConnectorLookup(
  kind: DataSourceConnector["kind"],
  datasets: DiscoveredDataset[],
): { get(sourceId: string): Promise<DataSourceConnector> } {
  return {
    async get(sourceId) {
      return {
        sourceId,
        kind,
        async checkHealth() {
          return { source_id: sourceId, status: "healthy", checked_at: "2026-08-31 10:00:00" };
        },
        async discoverCatalog() {
          return datasets;
        },
        async execute() {
          throw new Error("目录测试连接器不执行查询");
        },
        async close() {},
      };
    },
  };
}
