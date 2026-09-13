import { describe, expect, it, vi } from "vitest";
import type { DataAccessHeartbeat } from "@ai-data/contracts";
import { DataAccessHeartbeatClient } from "../../src/api/data-access-heartbeat-client";

const config = {
  base_url: "http://api:3101",
  heartbeat_path: "/internal/data-access/heartbeat",
  registration_credential_path: "credential.jwt",
  jwt_verification_public_key_path: "public.pem",
};
const heartbeat: DataAccessHeartbeat = {
  service_id: "das-a",
  service_protocol: "http",
  service_port: 3102,
  status: "healthy",
  sent_at: "2026-09-13 12:00:00",
  sources: [],
};
const session = { service_id: "das-a", session_token: "a".repeat(43), session_timeout_seconds: 90 };
const ack = { service_id: "das-a", accepted_at: "2026-09-13 12:00:00" };

describe("DAS 心跳客户端", () => {
  it("首次注册携带接入凭证，后续心跳携带返回的随机会话", async () => {
    const load = vi.fn(() => "registration-credential");
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, data: session })
      .mockResolvedValue({ status: 200, data: ack });
    const client = new DataAccessHeartbeatClient(config, load, { post });
    await client.send(heartbeat);
    await client.send(heartbeat);
    expect(post.mock.calls[0]).toEqual([
      "/internal/data-access/register",
      heartbeat,
      { headers: { authorization: "Bearer registration-credential" } },
    ]);
    expect(post.mock.calls[1]).toEqual([
      config.heartbeat_path,
      heartbeat,
      { headers: { authorization: `Bearer ${session.session_token}` } },
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("会话失效后读取当前文件凭证重新注册并切换会话", async () => {
    const load = vi.fn().mockReturnValueOnce("credential-v1").mockReturnValue("credential-v2");
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, data: session })
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200, data: { ...session, session_token: "b".repeat(43) } })
      .mockResolvedValue({ status: 200, data: ack });
    const client = new DataAccessHeartbeatClient(config, load, { post });
    await client.send(heartbeat);
    await client.send(heartbeat);
    await client.send(heartbeat);
    expect(load).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[2][2].headers.authorization).toBe("Bearer credential-v2");
    expect(post.mock.calls[3][2].headers.authorization).toBe(`Bearer ${"b".repeat(43)}`);
  });

  it("会话有效时的服务失败保持会话，下一轮继续心跳", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, data: session })
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValue({ status: 200, data: ack });
    const client = new DataAccessHeartbeatClient(config, () => "credential", { post });
    await client.send(heartbeat);
    await expect(client.send(heartbeat)).rejects.toThrow("503");
    await client.send(heartbeat);
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      "/internal/data-access/register",
      config.heartbeat_path,
      config.heartbeat_path,
    ]);
  });

  it.each(["wrong-service", "invalid-response", "rejected"])(
    "注册 %s 时拒绝保存会话",
    async (scenario) => {
      const post = vi.fn().mockResolvedValue({
        status: scenario === "rejected" ? 401 : 200,
        data: scenario === "wrong-service" ? { ...session, service_id: "das-b" } : {},
      });
      const client = new DataAccessHeartbeatClient(config, () => "credential", { post });
      await expect(client.send(heartbeat)).rejects.toThrow();
      await expect(client.send(heartbeat)).rejects.toThrow();
      expect(post.mock.calls.every((call) => call[0] === "/internal/data-access/register")).toBe(
        true,
      );
    },
  );

  it("同一轮慢注册只发送一次请求", async () => {
    let finish!: (value: unknown) => void;
    const post = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new DataAccessHeartbeatClient(config, () => "credential", { post });
    const first = client.send(heartbeat);
    const second = client.send(heartbeat);
    expect(post).toHaveBeenCalledOnce();
    finish({ status: 200, data: session });
    await Promise.all([first, second]);
  });
});
