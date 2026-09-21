import { describe, expect, it, vi } from "vitest";

import { apiDatasetConfigSchema, datasetSchema } from "@ai-data/contracts";

import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";

const columns = [
  { name: "id", data_type: "integer", nullable: false },
  { name: "org", data_type: "string", nullable: false },
  { name: "name", data_type: "string", nullable: false },
];
const datasets = ["parent", "detail"].map((object_id) =>
  datasetSchema.parse({
    source_id: "clinical",
    object_id,
    name: object_id,
    kind: "table",
    columns,
  }),
);

/** 保存基数前，从仓储取得目标键配置，并以原始目录核对当前双方字段。 */
function setup() {
  const target = apiDatasetConfigSchema.parse({
    source_id: "clinical",
    object_id: "detail",
    unique_keys: [["id", "org"]],
  });
  const repository = {
    find: vi.fn(async () => target),
    listBySourceId: async () => [target],
    save: vi.fn(async () => {}),
  };
  const permissions = {
    saveObjectPermission: async () => {},
    saveColumnPermission: async () => {},
    saveRowPolicy: async () => {},
    listObjectPermissions: async () => [],
    listColumnPermissions: async () => [],
    listRowPolicies: async () => [],
  };
  const service = new BusinessCatalogService(
    { listRawCatalog: async () => datasets },
    repository,
    permissions,
  );
  const config = apiDatasetConfigSchema.parse({
    source_id: "clinical",
    object_id: "parent",
    unique_keys: [["id", "org"]],
    approved_relations: [
      {
        relation_id: "detail",
        target_object_id: "detail",
        description: "复合键",
        cardinality: "one_to_one",
        column_pairs: [
          { source_column: "id", target_column: "id" },
          { source_column: "org", target_column: "org" },
        ],
      },
    ],
  });
  return { service, config, target, repository };
}

describe("业务关联键与基数配置保存", () => {
  it("被现有入向关系引用的唯一键不能在配置更新时移除", async () => {
    const { service, config, target, repository } = setup();
    target.object_id = "detail";
    config.approved_relations[0].target_object_id = "detail";
    repository.listBySourceId = async () => [config, target];
    await expect(service.saveConfig({ ...target, unique_keys: [["name"]] })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(repository.save).not.toHaveBeenCalled();
  });
  it("双方唯一键均覆盖Join字段时保存一对一并读取目标配置", async () => {
    const { service, config, repository } = setup();
    await service.saveConfig(config);
    expect(repository.find).toHaveBeenCalledWith("clinical", "detail");
    expect(repository.save).toHaveBeenCalledWith(config);
  });

  it.each([
    { unique_keys: [["missing"]] },
    { unique_keys: [["id", "id"]] },
    {
      unique_keys: [
        ["id", "org"],
        ["org", "id"],
      ],
    },
  ])("拒绝字段缺失或重复的unique_keys $unique_keys", async ({ unique_keys }) => {
    const { service, config, repository } = setup();
    await expect(service.saveConfig({ ...config, unique_keys })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it.each(["source", "target"])("%s缺少完整唯一键时拒绝声称一对一", async (side) => {
    const { service, config, target, repository } = setup();
    (side === "source" ? config : target).unique_keys = [["id", "name"]];
    await expect(service.saveConfig(config)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("拒绝两侧字段类型不同的批准关联", async () => {
    const { service, config } = setup();
    config.approved_relations[0].column_pairs[0].target_column = "name";
    await expect(service.saveConfig(config)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
