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
    registration_credential_path: "test-registration.jwt",
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

// 直接解析配置文本，覆盖结构与连接池约束；测试不读取公钥文件或建立数据库连接。
describe("DAS 启动配置", () => {
  it("配置实例密钥时可以省略 JWT 文件路径，公钥文件路径保持必填", () => {
    const api = {
      ...validConfig.api,
      registration_credential_path: undefined,
      registration_secret: "a".repeat(43),
    };
    expect(parseDasConfig(JSON.stringify({ ...validConfig, api })).api.registration_secret).toBe(
      api.registration_secret,
    );
    expect(() =>
      parseDasConfig(
        JSON.stringify({
          ...validConfig,
          api: { ...api, jwt_verification_public_key_path: undefined },
        }),
      ),
    ).toThrow();
  });
  it("同时配置实例密钥和凭据文件时拒绝启动", () => {
    expect(() =>
      parseDasConfig(
        JSON.stringify({
          ...validConfig,
          api: { ...validConfig.api, registration_secret: "a".repeat(43) },
        }),
      ),
    ).toThrow();
  });
  it.each(["", "short", "a".repeat(257), " ".repeat(43), "a".repeat(42) + "\n"])(
    "拒绝非法自动领取密钥 %j",
    (registration_secret) => {
      expect(() =>
        parseDasConfig(
          JSON.stringify({
            ...validConfig,
            api: {
              ...validConfig.api,
              registration_credential_path: undefined,
              registration_secret,
            },
          }),
        ),
      ).toThrow();
    },
  );
  it("接受完整合法的 DAS 配置", () => {
    expect(parseDasConfig(JSON.stringify(validConfig))).toEqual(validConfig);
  });

  it("按数据源保存独立的 SQL Server 链路选项", () => {
    const input = {
      ...validConfig,
      sqlserver_transports: {
        clinical: { encrypt: false, trust_server_certificate: true },
        reporting: { encrypt: true, trust_server_certificate: false },
      },
    };
    expect(parseDasConfig(JSON.stringify(input))).toEqual(input);
  });

  it("SQL Server 链路配置拒绝缺失布尔值、未知字段和空数据源标识", () => {
    for (const sqlserver_transports of [
      { clinical: { encrypt: false } },
      { clinical: { encrypt: "false", trust_server_certificate: true } },
      { clinical: { encrypt: false, trust_server_certificate: true, port: 1433 } },
      { "": { encrypt: false, trust_server_certificate: true } },
    ]) {
      expect(() =>
        parseDasConfig(JSON.stringify({ ...validConfig, sqlserver_transports })),
      ).toThrow();
    }
  });

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

  it("拒绝格式错误的 JSON", () => {
    expect(() => parseDasConfig("not-json")).toThrow("DAS 配置文件不是合法 JSON");
  });

  it.each(["heartbeat_path", "registration_path"])("%s 只允许 API 下的绝对路径", (field) => {
    for (const path of [
      "//other.example/path",
      "https://other.example/path",
      "/\\other.example/path",
    ]) {
      expect(() =>
        parseDasConfig(
          JSON.stringify({ ...validConfig, api: { ...validConfig.api, [field]: path } }),
        ),
      ).toThrow();
    }
  });

  it("未配置自动领取密钥时接入凭证文件路径为必填项", () => {
    expect(() =>
      parseDasConfig(
        JSON.stringify({
          ...validConfig,
          api: { ...validConfig.api, registration_credential_path: undefined },
        }),
      ),
    ).toThrow();
  });
});
