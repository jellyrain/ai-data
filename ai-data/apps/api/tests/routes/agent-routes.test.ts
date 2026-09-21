import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AgentService } from "../../src/agents/agent-service";
import { registerAgentRoutes } from "../../src/routes/agent-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { agentAdmin, agentDefinition, agentVersion } from "../agents/agent-fixtures";

function setup() {
  const service = {
    publish: vi.fn<AgentService["publish"]>(async () => agentVersion),
    list: vi.fn<AgentService["list"]>(async () => [agentVersion]),
    get: vi.fn<AgentService["get"]>(async () => agentVersion),
    setEnabled: vi.fn<AgentService["setEnabled"]>(async () => {}),
  };
  const auth = { loadContext: vi.fn(async () => agentAdmin) };
  const app = Fastify();
  registerContractErrorHandler(app);
  registerAgentRoutes(app, auth, service);
  return { app, service, auth };
}
const headers = { authorization: "Bearer agent-token" };

// 前提：请求持有有效身份。操作：发布、读取或启停 Agent。预期：认证上下文和版本参数完整传递，严格拒绝多余参数。
describe("Agent 管理 HTTP 接口", () => {
  it("发布版本返回 201，并将认证身份交给服务", async () => {
    const { app, service, auth } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      headers,
      payload: agentDefinition,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(agentVersion);
    expect(auth.loadContext).toHaveBeenCalledWith("agent-token");
    expect(service.publish).toHaveBeenCalledWith(agentAdmin, agentDefinition);
    await app.close();
  });
  it("清单及详情返回完整版本，查询版本被转换为正整数", async () => {
    const { app, service } = setup();
    expect((await app.inject({ url: "/agents", headers })).json()).toEqual({
      items: [agentVersion],
    });
    expect((await app.inject({ url: "/agents/outpatient?version=1", headers })).json()).toEqual(
      agentVersion,
    );
    expect(service.list).toHaveBeenCalledWith(agentAdmin);
    expect(service.get).toHaveBeenCalledWith(agentAdmin, "outpatient", 1);
    await app.inject({ url: "/agents/outpatient", headers });
    expect(service.get).toHaveBeenLastCalledWith(agentAdmin, "outpatient", undefined);
    await app.close();
  });
  it("启停成功返回 204", async () => {
    const { app, service } = setup();
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/agents/outpatient/status",
          headers,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(204);
    expect(service.setEnabled).toHaveBeenCalledWith(agentAdmin, "outpatient", false);
    await app.close();
  });
  it("拒绝错误版本、额外查询参数和伪造状态字段", async () => {
    const { app, service } = setup();
    for (const url of [
      "/agents/outpatient?version=0",
      "/agents/outpatient?organization_id=other",
      "/agents?organization_id=other",
    ]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    }
    for (const payload of [{ enabled: "false" }, { enabled: false, organization_id: "other" }]) {
      expect(
        (await app.inject({ method: "PATCH", url: "/agents/outpatient/status", headers, payload }))
          .statusCode,
      ).toBe(400);
    }
    expect(service.get).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.setEnabled).not.toHaveBeenCalled();
    await app.close();
  });
  it("缺少 Bearer 身份时不进入管理服务", async () => {
    const { app, service } = setup();
    expect((await app.inject({ url: "/agents" })).statusCode).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
    await app.close();
  });
});
