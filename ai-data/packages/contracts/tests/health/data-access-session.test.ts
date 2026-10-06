import { describe, expect, it } from "vitest";
import {
  dataAccessSessionSchema,
  dataAccessHeartbeatAckSchema,
  dataAccessCredentialRequestSchema,
  dataAccessCredentialResponseSchema,
} from "../../src/health/data-access-session";

describe("DAS 注册响应与心跳确认合同", () => {
  const session = { service_id: "das", session_token: "a".repeat(43), session_timeout_seconds: 90 };
  it("接受随机会话与有效心跳确认", () => {
    expect(dataAccessSessionSchema.safeParse(session).success).toBe(true);
    expect(
      dataAccessHeartbeatAckSchema.safeParse({
        service_id: "das",
        accepted_at: "2026-09-13 12:00:00",
      }).success,
    ).toBe(true);
  });
  it.each([
    { session_token: "" },
    { session_token: "not.a.jwt" },
    { session_timeout_seconds: 0 },
    { service_id: "" },
    { unexpected: true },
  ])("拒绝无效注册响应 %j", (override) => {
    expect(dataAccessSessionSchema.safeParse({ ...session, ...override }).success).toBe(false);
  });
});

describe("DAS 自动领取凭据合同", () => {
  it("接受实例请求及包含接入 JWT 的响应", () => {
    expect(dataAccessCredentialRequestSchema.parse({ service_id: "das-a" })).toEqual({
      service_id: "das-a",
    });
    expect(
      dataAccessCredentialResponseSchema.parse({ service_id: "das-a", credential: "signed-jwt" }),
    ).toEqual({ service_id: "das-a", credential: "signed-jwt" });
  });
  it.each([
    {},
    { service_id: "" },
    { service_id: "x".repeat(129) },
    { service_id: "das-a", extra: true },
  ])("拒绝非法领取请求 %j", (input) => {
    expect(dataAccessCredentialRequestSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    {},
    { credential: "" },
    { credential: "x".repeat(16385) },
    { service_id: "" },
    { extra: true },
  ])("拒绝非法领取响应（场景 %#）", (override) => {
    const input = Object.keys(override).length
      ? { service_id: "das-a", credential: "jwt", ...override }
      : { service_id: "das-a" };
    expect(dataAccessCredentialResponseSchema.safeParse(input).success).toBe(false);
  });
});
