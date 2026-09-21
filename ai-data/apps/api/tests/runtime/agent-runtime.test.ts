import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime/agent-runtime";
import { agentAdmin, agentDefinition, skillFingerprint } from "../agents/agent-fixtures";

// 会话绑定决定装配版本；当前启停状态和本地快照在每次运行前重新验证。
describe("Agent 会话装配", () => {
  function setup() {
    const definition = { ...agentDefinition, enabled: true, skill_fingerprint: skillFingerprint };
    const agents = { get: vi.fn(async () => definition) };
    const models = {
      resolve: vi.fn(async () => ({
        id: "provider",
        baseUrl: "http://localhost/v1",
        model: "demo",
        contextWindow: 8192,
      })),
    };
    const snapshot = {
      cwd: "fixed-directory",
      skills: { names: ["query-dsl"] },
      fingerprint: skillFingerprint,
    };
    const snapshots = { load: vi.fn(async () => snapshot) };
    const execute = vi.fn<
      (query: { sql: string }) => Promise<{ rows: { agent_id: string; agent_version: number }[] }>
    >(async () => ({
      rows: [{ agent_id: definition.agent_id, agent_version: 1 }],
    }));
    const database = {
      transaction: async (fn: (db: { execute: typeof execute }) => unknown) => fn({ execute }),
    };
    const runtime = new AgentRuntime({
      agents,
      models,
      snapshots,
      database,
    } as unknown as ConstructorParameters<typeof AgentRuntime>[0]);
    return { runtime, agents, models, snapshots, definition, execute };
  }
  it("新会话选择显式版本，运行只装配持久化版本的模型与 Skill", async () => {
    const s = setup();
    expect(await s.runtime.selectAgent(agentAdmin, "analysis", 1)).toEqual({
      agentId: s.definition.agent_id,
      agentVersion: 1,
    });
    const resolved = await s.runtime.resolveRun(agentAdmin, "run");
    expect(s.agents.get).toHaveBeenLastCalledWith(agentAdmin, s.definition.agent_id, 1);
    expect(s.models.resolve).toHaveBeenLastCalledWith(
      agentAdmin,
      s.definition.model_id,
      s.definition.model_version,
    );
    expect(s.snapshots.load).toHaveBeenCalledWith(
      agentAdmin.organizationId,
      s.definition.agent_id,
      1,
      s.definition.skill_names,
      skillFingerprint,
    );
    expect(resolved.configuration).toMatchObject({ cwd: "fixed-directory", contextWindow: 8192 });
  });
  it("已停用 Agent 拒绝新会话和旧会话运行", async () => {
    const s = setup();
    s.definition.enabled = false;
    await expect(s.runtime.selectAgent(agentAdmin, "analysis")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(s.runtime.resolveRun(agentAdmin, "run")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(s.snapshots.load).not.toHaveBeenCalled();
  });
  it("历史未绑定会话在事务内选取默认 Agent 并写入运行关联", async () => {
    const s = setup();
    s.execute.mockResolvedValueOnce({ rows: [{ agent_id: null, agent_version: null }] } as never);
    await s.runtime.resolveRun(agentAdmin, "run");
    expect(s.agents.get).toHaveBeenCalledWith(agentAdmin, "default", undefined);
    expect(
      s.execute.mock.calls.some(([q]) =>
        String((q as { sql: string }).sql).includes("UPDATE dbo.conversations"),
      ),
    ).toBe(true);
    expect(
      s.execute.mock.calls.some(([q]) =>
        String((q as { sql: string }).sql).includes("UPDATE dbo.analysis_runs"),
      ),
    ).toBe(true);
  });
});
