import { describe, expect, it } from "vitest";
import {
  dataAccessSessionSchema,
  dataAccessHeartbeatAckSchema,
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
