import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiDatasetConfigSchema, datasetSchema } from "@ai-data/contracts";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlCatalogRepository } from "../../src/catalog/sql-catalog-repository";
import { SqlRelationRepository } from "../../src/catalog/sql-relation-repository";
import { CatalogRelationService } from "../../src/catalog/catalog-relation-service";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { context } from "../support/api-fixtures";

/** 隔离库覆盖旧配置拆写、关系发布原子性及同一版本的并发保护。 */
describe("SQL Server：批准关系与目录配置共享存储", () => {
  const name = "ai_data_relations_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase,
    database: SqlServerMetadataDatabase,
    repository: SqlCatalogRepository,
    service: CatalogRelationService,
    catalog: BusinessCatalogService;
  let isCreated = false;
  const relation = {
    target_object_id: "b",
    description: "业务键",
    column_pairs: [{ source_column: "id", target_column: "id" }],
    cardinality: "many_to_one" as const,
  };
  const configs = ["a", "b", "c"].map((object_id) =>
    apiDatasetConfigSchema.parse({ source_id: "relations", object_id, unique_keys: [["id"]] }),
  );
  beforeAll(async () => {
    const path =
      process.env.SQLSERVER_TEST_CONFIG ??
      fileURLToPath(new URL("../../config/api.config.json", import.meta.url));
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const connection = apiConfigSchema.shape.metadata_sqlserver.parse(
      raw.metadata_sqlserver ?? raw,
    );
    admin = await SqlServerMetadataDatabase.connect({ ...connection, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    isCreated = true;
    database = await SqlServerMetadataDatabase.connect({ ...connection, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    await database.execute({
      sql: "INSERT INTO dbo.roles(id,code,name) VALUES('relation-reader','relation-reader',N'关系图读者')",
      parameters: [],
    });
    repository = new SqlCatalogRepository(database);
    for (const config of configs) await repository.save(config);
    const datasets = configs.map((config) =>
      datasetSchema.parse({
        source_id: config.source_id,
        object_id: config.object_id,
        name: config.object_id,
        kind: "table",
        columns: [
          { name: "id", data_type: "integer", nullable: false },
          { name: "name", data_type: "string", nullable: false },
        ],
      }),
    );
    const rawCatalog = { listRawCatalog: async () => datasets };
    catalog = new BusinessCatalogService(rawCatalog, repository, repository);
    service = new CatalogRelationService({
      repository: new SqlRelationRepository(database),
      rawCatalog,
      catalog,
    });
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (isCreated) {
        if (!/^ai_data_relations_test_[a-f0-9]{32}$/.test(name))
          throw new Error("测试数据库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  it("旧配置无标识关系拆入独立表，重复保存仍使用同一标识", async () => {
    const input = { ...configs[0], approved_relations: [relation] };
    await repository.save(input);
    const saved = await repository.find("relations", "a");
    const relationId = saved!.approved_relations[0].relation_id;
    expect(relationId).toMatch(/^legacy_/);
    await repository.save(input);
    expect((await repository.find("relations", "a"))!.approved_relations[0].relation_id).toBe(
      relationId,
    );
    const raw = await database.execute({
      sql: "SELECT config_json FROM dbo.api_dataset_configs WHERE source_id='relations' AND object_id='a'",
      parameters: [],
    });
    expect(JSON.parse(String(raw.rows[0].config_json))).not.toHaveProperty("approved_relations");
    expect((await service.graph(context, "relations", "b", true)).incoming).toHaveLength(1);
  });
  it("关系批次失败回滚，合法发布即时组装到旧配置读取", async () => {
    await expect(
      service.publish(context, "relations", {
        changes: [
          {
            action: "create",
            object_id: "c",
            relation: { ...relation, relation_id: "new", allowed_join_types: ["left"] },
          },
          { action: "disable", object_id: "c", relation_id: "missing", expected_version: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.find("relations", "c"))!.approved_relations).toEqual([]);
    await service.publish(context, "relations", {
      changes: [
        {
          action: "create",
          object_id: "c",
          relation: { ...relation, relation_id: "new", allowed_join_types: ["left"] },
        },
      ],
    });
    expect((await repository.find("relations", "c"))!.approved_relations).toMatchObject([
      { relation_id: "new", allowed_join_types: ["left"] },
    ]);
  });
  it("两个相同期望配置版本只有一个提交，关系更新也使旧配置版本过期", async () => {
    const current = await repository.find("relations", "c");
    const version = await repository.getVersion("relations", "c");
    const results = await Promise.allSettled([
      repository.save({ ...current!, business_description: "甲" }, version),
      repository.save({ ...current!, business_description: "乙" }, version),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
    ]);
    const stale = await repository.getVersion("relations", "c");
    const edge = (await service.graph(context, "relations", "c", true)).outgoing[0];
    await service.publish(context, "relations", {
      changes: [
        {
          action: "disable",
          object_id: "c",
          relation_id: edge.relation_id,
          expected_version: edge.version,
        },
      ],
    });
    await expect(repository.save(current!, stale)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.find("relations", "c"))!.approved_relations).toEqual([]);
  });
  it("SQL权限变化收回普通图关系字段，管理图和入向方向保持完整", async () => {
    for (const object_id of ["a", "b"])
      await repository.saveObjectPermission("relations", {
        role_id: "relation-reader",
        object_id,
        effect: "allow",
      });
    const reader = { ...context, roles: ["reader"], roleIds: ["relation-reader"] };
    expect((await service.graph(reader, "relations", "b")).incoming).toHaveLength(1);
    expect((await service.graph(reader, "relations", "b")).outgoing).toHaveLength(0);
    await repository.saveColumnPermission("relations", {
      role_id: "relation-reader",
      object_id: "a",
      column: "id",
      effect: "deny",
    });
    expect((await service.graph(reader, "relations", "b")).incoming).toEqual([]);
    expect(
      (await service.graph(context, "relations", "b", true)).incoming.some(
        (item) => item.object_id === "a",
      ),
    ).toBe(true);
  });
  it("配置编辑不能移除已发布入向关系的唯一键，数据库版本保持原状", async () => {
    const previous = await repository.find("relations", "b");
    const version = await repository.getVersion("relations", "b");
    await expect(
      catalog.saveConfig({ ...previous!, unique_keys: [["name"]] }, version),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await repository.getVersion("relations", "b")).toBe(version);
    expect((await repository.find("relations", "b"))!.unique_keys).toEqual([["id"]]);
  });
});
