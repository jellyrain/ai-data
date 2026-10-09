import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiDatasetConfigSchema } from "@ai-data/contracts";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlCatalogRepository } from "../../src/catalog/sql-catalog-repository";
import { SqlDataSourceLifecycle } from "../../src/data-access/sql-data-source-lifecycle";

describe("SQL Server：数据源当前配置清理", () => {
  const name = "ai_data_source_cleanup_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase,
    database: SqlServerMetadataDatabase,
    store: SqlDataSourceLifecycle;
  let created = false;
  const tables = [
    "api_dataset_configs",
    "approved_relations",
    "role_object_permissions",
    "role_column_permissions",
    "role_row_policies",
  ];
  beforeAll(async () => {
    const path =
      process.env.SQLSERVER_TEST_CONFIG ??
      fileURLToPath(new URL("../../config/api.config.json", import.meta.url));
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const config = apiConfigSchema.shape.metadata_sqlserver.parse(raw.metadata_sqlserver ?? raw);
    admin = await SqlServerMetadataDatabase.connect({ ...config, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({ ...config, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    store = new SqlDataSourceLifecycle(database);
    await database.execute({
      sql: "INSERT INTO dbo.organizations(id,code,name) VALUES('cleanup-org','cleanup-org',N'测试组织'); INSERT INTO dbo.roles(id,code,name) VALUES('cleanup-role','cleanup-role',N'测试角色')",
      parameters: [],
    });
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_source_cleanup_test_[a-f0-9]{32}$/.test(name))
          throw new Error("测试库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  async function seed(sourceId: string) {
    await new SqlCatalogRepository(database).save(
      apiDatasetConfigSchema.parse({
        source_id: sourceId,
        object_id: "table.dbo.床位",
        business_description: "旧目录说明",
      }),
    );
    await database.execute({
      sql: `INSERT INTO dbo.approved_relations(source_id,object_id,relation_id,target_object_id,version,enabled,record_json) VALUES(@source_id,'table.dbo.床位','relation','department',1,1,'{}');
      INSERT INTO dbo.role_object_permissions(source_id,role_id,object_id,effect) VALUES(@source_id,'cleanup-role','table.dbo.床位','allow');
      INSERT INTO dbo.role_column_permissions(source_id,role_id,object_id,column_name,effect) VALUES(@source_id,'cleanup-role','table.dbo.床位','id','allow');
      INSERT INTO dbo.role_row_policies(source_id,role_id,object_id,condition_json) VALUES(@source_id,'cleanup-role','table.dbo.床位','{}');
      INSERT INTO dbo.catalog_policy_versions(organization_id,source_id,role_id,version,record_json) VALUES('cleanup-org',@source_id,'cleanup-role',1,'{}');`,
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });
  }
  async function counts(sourceId: string) {
    const values = [];
    for (const table of [...tables, "catalog_policy_versions"]) {
      const result = await database.execute({
        sql: `SELECT COUNT(*) AS total FROM dbo.${table} WHERE source_id=@source_id`,
        parameters: [{ name: "source_id", type: "string", value: sourceId }],
      });
      values.push(result.rows[0].total);
    }
    return values;
  }
  it("只清理目标源五类当前配置，保留其他源和历史策略；重复执行安全", async () => {
    await seed("危急值数据");
    await seed("其他源");
    await store.run("危急值数据", (clear) => clear());
    expect(await counts("危急值数据")).toEqual([0, 0, 0, 0, 0, 1]);
    expect(await counts("其他源")).toEqual([1, 1, 1, 1, 1, 1]);
    await store.run("危急值数据", (clear) => clear());
    expect(await counts("危急值数据")).toEqual([0, 0, 0, 0, 0, 1]);
    expect(
      await new SqlCatalogRepository(database).find("危急值数据", "table.dbo.床位"),
    ).toBeNull();
  });
  it("清理中途失败时五类配置一起回滚", async () => {
    await seed("回滚源");
    await expect(
      store.run("回滚源", async (clear) => {
        await clear();
        throw new Error("模拟后续失败");
      }),
    ).rejects.toThrow("模拟后续失败");
    expect(await counts("回滚源")).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("两个 API 管理操作串行处理同名源", async () => {
    const order: string[] = [];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = store.run("并发源", async () => {
      order.push("删除开始");
      entered();
      await gate;
      order.push("删除结束");
    });
    await ready;
    const second = store.run("并发源", async () => {
      order.push("重建");
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["删除开始", "删除结束", "重建"]);
  });
});
