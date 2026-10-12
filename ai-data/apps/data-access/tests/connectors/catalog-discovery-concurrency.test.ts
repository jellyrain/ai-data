import { describe, expect, it, vi } from "vitest";
import { DatabaseConnector } from "../../src/connectors/database-connector";
import { sqlServerDialect } from "../../src/connectors/dialects";
import { CatalogService } from "../../src/catalog/catalog-service";
import { queryCapabilitiesSchema } from "@ai-data/contracts";

/** 用可控驱动复现大量目录请求同时抵达容量为 1 的数据源。 */
function setup() {
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const query = vi.fn(async () => {
    await barrier;
    return {
      rows: [
        {
          schema_name: "dbo",
          object_name: "visit",
          object_kind: "table",
          column_name: "id",
          data_type: "int",
          is_nullable: false,
        },
      ],
    };
  });
  const connector = new DatabaseConnector(
    {
      sourceId: "s",
      connectorKind: "sqlserver",
      secretRef: "secret",
      timeoutMs: 10000,
      connectionPoolLimit: 1,
      concurrencyLimit: 1,
      rowLimit: 100,
      costLimit: 1000,
    },
    { query, close: async () => {} },
    sqlServerDialect,
  );
  return { connector, query, finish };
}
describe("同源在途目录发现", () => {
  it("二十份并发目录读取共享一次驱动查询，每个调用方获得独立副本，结束后重新发现", async () => {
    const h = setup();
    const pending = Promise.allSettled(
      Array.from({ length: 20 }, () => h.connector.discoverCatalog()),
    );
    h.finish();
    const results = await pending;
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(h.query).toHaveBeenCalledTimes(1);
    if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
      results[0].value[0].columns.length = 0;
      expect(results[1].value[0].columns).toHaveLength(1);
    }
    await h.connector.discoverCatalog();
    expect(h.query).toHaveBeenCalledTimes(2);
    await h.connector.close();
  });
  it("失败传播给全部等待者，下一次发现能够重试", async () => {
    const h = setup();
    h.query.mockRejectedValueOnce(new Error("目录读取失败"));
    h.finish();
    const results = await Promise.allSettled([
      h.connector.discoverCatalog(),
      h.connector.discoverCatalog(),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(h.query).toHaveBeenCalledTimes(1);
    await expect(h.connector.discoverCatalog()).resolves.toHaveLength(1);
    expect(h.query).toHaveBeenCalledTimes(2);
    await h.connector.close();
  });
  it("合并物理发现后每份请求独立读取白名单，白名单变化立即影响返回", async () => {
    const h = setup();
    const exposed = vi.fn(async () => [
      {
        sourceId: "s",
        objectId: "visit",
        objectKind: "table" as const,
        nativeSchemaName: "dbo",
        nativeObjectName: "visit",
        isDiscoverable: true,
        isQueryable: true,
        queryCapabilities: queryCapabilitiesSchema.parse({}),
      },
    ]);
    exposed.mockResolvedValueOnce([]);
    const service = new CatalogService(
      { get: async () => h.connector },
      { listDiscoverableBySourceId: exposed },
    );
    const pending = Promise.all([service.listBySourceId("s"), service.listBySourceId("s")]);
    h.finish();
    const [hidden, visible] = await pending;
    expect(hidden).toEqual([]);
    expect(visible.map((item) => item.object_id)).toEqual(["visit"]);
    expect(exposed).toHaveBeenCalledTimes(2);
    expect(h.query).toHaveBeenCalledTimes(1);
    await h.connector.close();
  });
});
