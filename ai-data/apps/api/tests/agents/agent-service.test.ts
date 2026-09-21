import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../src/agents/agent-service";
import type { AgentRepository } from "../../src/agents/agent-types";
import { ApplicationError } from "../../src/errors/application-error";
import { agentAdmin, agentDefinition, agentVersion, skillFingerprint } from "./agent-fixtures";

/** 仓储替身只提供服务所需能力，版本竞争由 SQL 集成场景验证。 */
function setup() {
  const repository = {
    publish: vi.fn<AgentRepository["publish"]>(async (_org, definition, fingerprint) => ({
      ...definition,
      skill_fingerprint: fingerprint,
      enabled: true,
    })),
    find: vi.fn<AgentRepository["find"]>(async () => null),
    list: vi.fn<AgentRepository["list"]>(async () => [agentVersion]),
    setEnabled: vi.fn<AgentRepository["setEnabled"]>(async () => true),
  };
  const resolveModel = vi.fn(async () => {});
  const prepareSkills = vi.fn(async () => ({ fingerprint: skillFingerprint }));
  const service = new AgentService({
    repository,
    resolveModel,
    prepareSkills,
    listToolNames: () => ["query_data", "read_skill_reference"],
  });
  return { service, repository, resolveModel, prepareSkills };
}

// 前提：资源已注册。操作：发布 Agent 版本或修改状态。预期：按可信组织校验权限、资源及版本快照。
describe("Agent 配置发布与组织范围", () => {
  it("管理员发布时校验模型、准备资源，再保存完整版本", async () => {
    const { service, repository, resolveModel, prepareSkills } = setup();
    await expect(service.publish(agentAdmin, agentDefinition)).resolves.toEqual(agentVersion);
    expect(resolveModel).toHaveBeenCalledWith(agentAdmin, "analysis-model", 1);
    expect(prepareSkills).toHaveBeenCalledWith("hospital-a", "outpatient", 1, ["query-analysis"]);
    expect(repository.publish).toHaveBeenCalledWith(
      "hospital-a",
      agentDefinition,
      skillFingerprint,
    );
    expect(resolveModel.mock.invocationCallOrder[0]).toBeLessThan(
      prepareSkills.mock.invocationCallOrder[0],
    );
    expect(prepareSkills.mock.invocationCallOrder[0]).toBeLessThan(
      repository.publish.mock.invocationCallOrder[0],
    );
  });

  it("持有 Agent 管理权限的用户可以发布空 Skill 和工具配置", async () => {
    const { service, prepareSkills } = setup();
    const definition = { ...agentDefinition, tool_names: [], skill_names: [] };
    const context = { ...agentAdmin, roles: [], permissions: ["agents:manage"] };
    await expect(service.publish(context, definition)).resolves.toMatchObject(definition);
    expect(prepareSkills).toHaveBeenCalledWith("hospital-a", "outpatient", 1, []);
  });

  it("普通用户不能发布和启停 Agent，资源准备也不会执行", async () => {
    const { service, repository, resolveModel, prepareSkills } = setup();
    const context = { ...agentAdmin, roles: [], permissions: [] };
    await expect(service.publish(context, agentDefinition)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(service.setEnabled(context, "outpatient", false)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(prepareSkills).not.toHaveBeenCalled();
    expect(repository.setEnabled).not.toHaveBeenCalled();
  });

  it("发布包含未知工具时拒绝，模型和 Skill 不进入准备流程", async () => {
    const { service, repository, resolveModel, prepareSkills } = setup();
    await expect(
      service.publish(agentAdmin, {
        ...agentDefinition,
        tool_names: ["unknown", "read_skill_reference"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(prepareSkills).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("模型校验失败时保留分类错误且不发布版本", async () => {
    const { service, repository, resolveModel, prepareSkills } = setup();
    resolveModel.mockRejectedValue(new ApplicationError("NOT_FOUND", "模型不存在"));
    await expect(service.publish(agentAdmin, agentDefinition)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prepareSkills).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("Skill 快照创建失败时不发布版本", async () => {
    const { service, repository, prepareSkills } = setup();
    prepareSkills.mockRejectedValue(new ApplicationError("INVALID_INPUT", "Skill 不存在"));
    await expect(service.publish(agentAdmin, agentDefinition)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("已发布版本或跳号版本在准备资源前被拒绝", async () => {
    const { service, repository, prepareSkills } = setup();
    repository.find.mockResolvedValue(agentVersion);
    for (const version of [1, 3])
      await expect(
        service.publish(agentAdmin, { ...agentDefinition, version }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prepareSkills).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("未知发布字段及无效配置由严格合同拒绝", async () => {
    const { service, repository } = setup();
    await expect(
      service.publish(agentAdmin, { ...agentDefinition, organization_id: "other" }),
    ).rejects.toThrow();
    await expect(
      service.publish(agentAdmin, { ...agentDefinition, model_version: 0 }),
    ).rejects.toThrow();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("普通用户读取本组织的清单、最新版本和指定版本", async () => {
    const { service, repository } = setup();
    repository.find.mockResolvedValue(agentVersion);
    const context = { ...agentAdmin, roles: [], permissions: [] };
    await expect(service.list(context)).resolves.toEqual([agentVersion]);
    await expect(service.get(context, "outpatient")).resolves.toEqual(agentVersion);
    await service.get(context, "outpatient", 1);
    expect(repository.list).toHaveBeenCalledWith("hospital-a");
    expect(repository.find).toHaveBeenNthCalledWith(1, "hospital-a", "outpatient", undefined);
    expect(repository.find).toHaveBeenNthCalledWith(2, "hospital-a", "outpatient", 1);
  });

  it("读取其他组织或不存在的 Agent 返回资源不存在", async () => {
    const { service, repository } = setup();
    repository.find.mockResolvedValue(null);
    await expect(
      service.get({ ...agentAdmin, organizationId: "hospital-b" }, "outpatient"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(repository.find).toHaveBeenCalledWith("hospital-b", "outpatient", undefined);
  });

  it("启停绑定当前组织，缺少资源返回资源不存在", async () => {
    const { service, repository } = setup();
    await service.setEnabled(agentAdmin, "outpatient", false);
    expect(repository.setEnabled).toHaveBeenCalledWith("hospital-a", "outpatient", false);
    repository.setEnabled.mockResolvedValue(false);
    await expect(service.setEnabled(agentAdmin, "missing", true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
