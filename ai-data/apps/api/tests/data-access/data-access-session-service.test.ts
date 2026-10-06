import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataAccessHeartbeat } from "@ai-data/contracts";
import { DataAccessSessionService } from "../../src/data-access/data-access-session-service";
import { InMemoryDataAccessServiceRegistry } from "../../src/data-access/data-access-registry";
import { createServiceJwt } from "../support/service-auth-fixtures";

const heartbeat: DataAccessHeartbeat = {
  service_id: "das-a",
  service_port: 3102,
  service_protocol: "http",
  status: "healthy",
  sent_at: "2026-09-13 12:00:00",
  sources: [],
};
const url = "http://127.0.0.1:3102";

/** 使用真实 JWT 和内存健康仓储检查注册、会话和调度之间的关系。 */
async function createService() {
  const jwt = await createServiceJwt();
  const trusted = [
    { service_id: "das-a", credential_version: 1, enabled: true },
    { service_id: "das-b", credential_version: 1, enabled: true },
  ];
  const registry = new InMemoryDataAccessServiceRegistry();
  const write = vi.spyOn(registry, "registerHeartbeat");
  const verify = vi.spyOn(jwt, "verifyRegistrationCredential");
  const service = new DataAccessSessionService(registry, jwt, trusted);
  const credential = await service.issueCredential("das-a");
  return { service, registry, jwt, trusted, credential, write, verify };
}

describe("DAS 注册和心跳会话", () => {
  it("失联实例从执行发现移除，但保留在管理记录中", async () => {
    const { service, credential } = await createService();
    await service.register(heartbeat, url, credential);
    expect((await service.listRegisteredServices())[0]?.connectionStatus).toBe("online");
    vi.setSystemTime(Date.now() + 90_000);
    expect(await service.listHealthyServices()).toEqual([]);
    expect(await service.listRegisteredServices()).toEqual([
      expect.objectContaining({ serviceId: "das-a", connectionStatus: "offline" }),
    ]);
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T04:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("首次注册验签，连续心跳只检查随机会话并续接存活时间", async () => {
    const { service, credential, verify } = await createService();
    const session = await service.register(heartbeat, url, credential);
    expect(session).toMatchObject({ service_id: "das-a", session_timeout_seconds: 90 });
    expect(session.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (let index = 0; index < 4; index++) {
      vi.setSystemTime(Date.now() + 30_000);
      await service.heartbeat(heartbeat, url, session.session_token);
    }
    expect(verify).toHaveBeenCalledOnce();
    expect(await service.listHealthyServices()).toHaveLength(1);
  });

  it.each(["unknown", "wrong-token", "wrong-service", "changed-address", "expired"])(
    "拒绝 %s 会话且不改写健康记录",
    async (scenario) => {
      const { service, credential, write } = await createService();
      const session = await service.register(heartbeat, url, credential);
      write.mockClear();
      if (scenario === "expired") vi.setSystemTime(Date.now() + 90_000);
      await expect(
        service.heartbeat(
          {
            ...heartbeat,
            service_id:
              scenario === "unknown" ? "unknown" : scenario === "wrong-service" ? "das-b" : "das-a",
          },
          scenario === "changed-address" ? "http://127.0.0.2:3102" : url,
          scenario === "wrong-token" ? "x".repeat(43) : session.session_token,
        ),
      ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("接入凭证只能在注册入口使用", async () => {
    const { service, credential } = await createService();
    await service.register(heartbeat, url, credential);
    await expect(service.heartbeat(heartbeat, url, credential)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("重新注册替换旧会话并允许更新实例地址", async () => {
    const { service, credential } = await createService();
    const first = await service.register(heartbeat, url, credential);
    const newUrl = "http://127.0.0.2:3102";
    const second = await service.register(heartbeat, newUrl, credential);
    expect(second.session_token).not.toBe(first.session_token);
    await expect(service.heartbeat(heartbeat, url, first.session_token)).rejects.toThrow();
    await expect(
      service.heartbeat(heartbeat, newUrl, second.session_token),
    ).resolves.toBeUndefined();
  });

  it("API 重启后旧健康记录不参与调度，重新注册后恢复", async () => {
    const { service, registry, jwt, trusted, credential } = await createService();
    const session = await service.register(heartbeat, url, credential);
    const restarted = new DataAccessSessionService(registry, jwt, trusted);
    expect(await restarted.listHealthyServices()).toEqual([]);
    await expect(restarted.heartbeat(heartbeat, url, session.session_token)).rejects.toThrow();
    await restarted.register(heartbeat, url, credential);
    expect(await restarted.listHealthyServices()).toHaveLength(1);
  });

  it.each(["disabled", "version"])("实例 %s 后旧凭证及会话均失效", async (change) => {
    const { service, credential, trusted } = await createService();
    const session = await service.register(heartbeat, url, credential);
    if (change === "disabled") trusted[0].enabled = false;
    else trusted[0].credential_version++;
    await expect(service.heartbeat(heartbeat, url, session.session_token)).rejects.toThrow();
    await expect(service.register(heartbeat, url, credential)).rejects.toThrow();
    expect(await service.listHealthyServices()).toEqual([]);
  });

  it("会话到期后移出查询调度", async () => {
    const { service, credential } = await createService();
    await service.register(heartbeat, url, credential);
    vi.setSystemTime(Date.now() + 90_000);
    expect(await service.listHealthyServices()).toEqual([]);
  });

  it("事务健康读取复用注册会话且不借用根仓储连接", async () => {
    const { service, registry, credential } = await createService();
    await service.register(heartbeat, url, credential);
    const rows = await registry.listHealthyServices();
    const transaction = { listHealthyServices: vi.fn(async () => rows) };
    const rootRead = vi
      .spyOn(registry, "listHealthyServices")
      .mockRejectedValue(new Error("根连接已被事务占用"));
    expect(await service.listHealthyServices(transaction)).toEqual(rows);
    expect(transaction.listHealthyServices).toHaveBeenCalledOnce();
    expect(rootRead).not.toHaveBeenCalled();
  });

  it.each(["expired", "disabled", "version", "address", "restart"])(
    "事务健康快照不能绕过 %s 会话检查",
    async (change) => {
      const { service, registry, trusted, jwt, credential } = await createService();
      await service.register(heartbeat, url, credential);
      const rows = await registry.listHealthyServices();
      const transaction = { listHealthyServices: async () => rows };
      if (change === "expired") vi.setSystemTime(Date.now() + 90_000);
      if (change === "disabled") trusted[0].enabled = false;
      if (change === "version") trusted[0].credential_version++;
      if (change === "address") rows[0].serviceUrl = "http://127.0.0.2:3102";
      const current =
        change === "restart" ? new DataAccessSessionService(registry, jwt, trusted) : service;
      expect(await current.listHealthyServices(transaction)).toEqual([]);
    },
  );

  it("登记持久化失败时不建立会话", async () => {
    const { service, credential, write } = await createService();
    write.mockRejectedValueOnce(new Error("metadata unavailable"));
    await expect(service.register(heartbeat, url, credential)).rejects.toThrow(
      "metadata unavailable",
    );
    expect(await service.listHealthyServices()).toEqual([]);
  });

  it("先到达的重新注册完成后，旧会话的排队心跳被拒绝", async () => {
    const { service, credential, write } = await createService();
    const first = await service.register(heartbeat, url, credential);
    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    write.mockImplementationOnce(async (body, target) => {
      await pendingWrite;
      return {
        serviceId: body.service_id,
        serviceUrl: target,
        status: body.status,
        serviceVersion: null,
        lastHeartbeatAt: new Date(),
        message: null,
        sources: [],
      };
    });
    const registering = service.register(heartbeat, "http://127.0.0.2:3102", credential);
    // 等到注册写入开始，再提交旧会话心跳。
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    const oldHeartbeat = service.heartbeat(heartbeat, url, first.session_token);
    const rejection = expect(oldHeartbeat).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    finishWrite();
    await registering;
    await rejection;
    expect(write).toHaveBeenCalledTimes(2);
  });
});
