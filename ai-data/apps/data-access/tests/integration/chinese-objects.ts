import { expect } from "vitest";
import { manageableSourceObjectSchema } from "@ai-data/contracts";
import type { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import type { DataSourceManagementService } from "../../src/data-sources/data-source-management-service";
import type { DataSourceManager } from "../../src/data-sources/data-source-manager";
import type { DataSourceRepository } from "../../src/metadata/data-source-repository";
import { ExposedObjectRepository } from "../../src/metadata/exposed-object-repository";
import { CatalogService } from "../../src/catalog/catalog-service";
import { QueryPlanner } from "../../src/query-planning/query-planner";
import { createSignedRequest } from "../support/internal-query-fixtures";

/** 在隔离库验证中文对象及含美元符号字段的发现、白名单和真实查询。 */
export async function verifyChineseObjects(
  database: SqlServerMetadataDatabase,
  management: DataSourceManagementService,
  runtime: DataSourceManager,
  configs: DataSourceRepository,
) {
  await database.execute({ sql: "CREATE SCHEMA [业务]", parameters: [] });
  await database.execute({
    sql: "CREATE TABLE [业务].[科室] ([编号] INT PRIMARY KEY, [科室名称] NVARCHAR(40) NOT NULL, [__$operation] INT NOT NULL); INSERT INTO [业务].[科室] VALUES (1,N'内科',2),(2,N'外科',4);",
    parameters: [],
  });
  await database.execute({
    sql: "CREATE VIEW [业务].[科室视图] AS SELECT [编号], [科室名称], [__$operation] FROM [业务].[科室]",
    parameters: [],
  });
  // 表与视图的数据库注释应完整传到发现和白名单目录，其他扩展属性不应混入。
  const sourceDescription = "科室名称（数据库说明）\n含中文与 ' 引号";
  for (const [kind, name] of [
    ["TABLE", "科室"],
    ["VIEW", "科室视图"],
  ]) {
    for (const column of [undefined, "科室名称"]) {
      await database.execute({
        sql: `EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=@description,
          @level0type=N'SCHEMA', @level0name=N'业务', @level1type=@kind, @level1name=@object
          ${column ? ", @level2type=N'COLUMN', @level2name=@column" : ""}`,
        parameters: [
          { name: "description", type: "string", value: column ? sourceDescription : "科室源说明" },
          { name: "kind", type: "string", value: kind },
          { name: "object", type: "string", value: name },
          ...(column ? [{ name: "column", type: "string" as const, value: column }] : []),
        ],
      });
    }
  }
  await database.execute({
    sql: `EXEC sys.sp_addextendedproperty @name=N'OtherProperty', @value=N'其他属性',
      @level0type=N'SCHEMA', @level0name=N'业务', @level1type=N'TABLE', @level1name=N'科室',
      @level2type=N'COLUMN', @level2name=N'科室名称'`,
    parameters: [],
  });
  const source_id = "门诊数据";
  const discovered = manageableSourceObjectSchema
    .array()
    .parse((await management.discoverSourceObjects({ source_id })).items);
  const ids = ["table.业务.科室", "view.业务.科室视图"];
  for (const object_id of ids) {
    const item = discovered.find((item) => item.object_id === object_id)!;
    expect(item.source_description).toBe("科室源说明");
    expect(item.columns.find((c) => c.name === "科室名称")?.source_description).toBe(
      sourceDescription,
    );
    expect(item.columns.find((c) => c.name === "编号")?.source_description).toBeUndefined();
    expect(
      discovered.find((item) => item.object_id === object_id)?.columns.map((column) => column.name),
    ).toEqual(["编号", "科室名称", "__$operation"]);
  }
  await management.replaceSourceObjects({
    source_id,
    objects: ids.map((object_id) => ({ object_id })),
    expected_revision: (await management.getSourceObjects(source_id)).revision,
  });
  const objects = new ExposedObjectRepository(database);
  const catalog = await new CatalogService(runtime, objects).listBySourceId(source_id);
  expect(catalog.map((item) => item.object_id).sort()).toEqual(ids);
  expect(
    catalog.every(
      (item) =>
        item.columns.find((c) => c.name === "科室名称")?.source_description === sourceDescription,
    ),
  ).toBe(true);
  // 本用例覆盖规划与 SQL，签名及权限在专用授权测试中验证。
  const planner = new QueryPlanner(configs, objects, { verify: async () => {} });
  const request = (object_id: string) =>
    createSignedRequest(
      { output_masks: [] },
      {
        type: "relational_query",
        source_id,
        from: { object_id, alias: "科室" },
        select: [
          { field: "科室.编号", as: "编号" },
          { field: "科室.科室名称", as: "名称" },
          { field: "科室.__$operation", as: "操作$类型" },
        ],
        filters: {
          logic: "and",
          items: [
            { field: "科室.科室名称", op: "eq", data_type: "string", value: "内科" },
            { field: "科室.__$operation", op: "eq", data_type: "integer", value: 2 },
          ],
        },
        order_by: [{ field: "操作$类型", direction: "asc" }],
      },
    );
  const connector = await runtime.get(source_id);
  for (const object_id of ids) {
    const plan = await planner.plan(request(object_id));
    const result = await connector.execute(plan.query);
    expect(result.rows).toEqual([{ 编号: 1, 名称: "内科", 操作$类型: 2 }]);
    expect(result.execution_sql?.sql).toContain("[业务].[");
    expect(result.execution_sql?.sql).toContain("[科室].[__$operation] AS [操作$类型]");
  }
  await management.replaceSourceObjects({
    source_id,
    objects: [{ object_id: ids[0] }],
    expected_revision: (await management.getSourceObjects(source_id)).revision,
  });
  expect(
    (await management.getSourceObjects(source_id)).items.map((item) => item.object_id),
  ).toEqual([ids[0]]);
  await expect(planner.plan(request(ids[1]))).rejects.toThrow();
}
