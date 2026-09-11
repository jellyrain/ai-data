import { describe, expect, it } from "vitest";

import { parseDasConfig } from "../../src/config/das-config";

const validConfig = {
  service: {
    host: "127.0.0.1",
    port: 3102,
    service_id: "data-access-test",
    service_version: "0.1.0",
  },
  api: {
    base_url: "http://127.0.0.1:3101",
    heartbeat_path: "/internal/data-access/heartbeat",
    jwt_verification_public_key_path: "./test-public.pem",
  },
  metadata_sqlserver: {
    server: "127.0.0.1",
    port: 1433,
    database: "das_meta_test",
    user: "das_service",
    password: "test-password",
    options: {
      encrypt: false,
      trust_server_certificate: true,
      connection_timeout_ms: 5000,
      request_timeout_ms: 15000,
      pool: {
        max: 10,
        min: 0,
        idle_timeout_ms: 30000,
      },
    },
  },
};

describe("DAS 启动配置", () => {
  // BDD 场景：部署提供完整 JSON 配置；TDD 断言：加载后保留可启动配置。
  it("接受完整合法的 DAS 配置", () => {
    expect(parseDasConfig(JSON.stringify(validConfig))).toEqual(validConfig);
  });

  // BDD 场景：配置文件被误编辑为未知字段；TDD 断言：严格 Schema 拒绝该配置。
  it("拒绝未声明的配置字段", () => {
    expect(() =>
      parseDasConfig(
        JSON.stringify({
          ...validConfig,
          unexpected: true,
        }),
      ),
    ).toThrow();
  });

  // BDD 场景：连接池最小连接数超过最大连接数；TDD 断言：拒绝无法兑现的连接池限制。
  it("拒绝最小连接数大于最大连接数", () => {
    expect(() =>
      parseDasConfig(
        JSON.stringify({
          ...validConfig,
          metadata_sqlserver: {
            ...validConfig.metadata_sqlserver,
            options: {
              ...validConfig.metadata_sqlserver.options,
              pool: {
                ...validConfig.metadata_sqlserver.options.pool,
                min: 11,
              },
            },
          },
        }),
      ),
    ).toThrow("metadata_sqlserver.options.pool.min 不能大于 max");
  });

  // BDD 场景：配置文件内容不是 JSON；TDD 断言：启动前明确报告格式错误。
  it("拒绝格式错误的 JSON", () => {
    expect(() => parseDasConfig("not-json")).toThrow("DAS 配置文件不是合法 JSON");
  });
});
