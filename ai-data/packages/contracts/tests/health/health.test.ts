import { describe, expect, it } from "vitest";

import { dataAccessHeartbeatSchema, sourceHealthSchema } from "../../src/health/health";

describe("数据源健康与服务心跳合同", () => {
  it("接受单个数据源健康状态", () => {
    expect(
      sourceHealthSchema.safeParse({
        source_id: "clinical",
        status: "unhealthy",
        checked_at: "2026-08-24 12:00:00",
        message: "连接超时",
      }).success,
    ).toBe(true);
  });

  it("接受数据访问服务心跳", () => {
    expect(
      dataAccessHeartbeatSchema.safeParse({
        service_id: "data-access-01",
        service_port: 3102,
        service_protocol: "http",
        status: "healthy",
        sent_at: "2026-08-25 18:30:00",
        service_version: "0.1.0",
        sources: [
          {
            source_id: "clinical",
            status: "healthy",
            checked_at: "2026-08-25 18:29:58",
          },
        ],
      }).success,
    ).toBe(true);
  });
});
