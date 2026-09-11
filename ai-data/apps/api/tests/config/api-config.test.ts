import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadApiConfig, parseApiConfig, parseApiEnvironment } from "../../src/config/api-config";

const validEnvironment = {
  NODE_ENV: "test",
  API_PORT: "3000",
  API_HOST: "127.0.0.1",
  API_SERVICE_ID: "ai-bi-api",
  API_SERVICE_VERSION: "1.0.0",
  META_SQLSERVER_SERVER: "localhost",
  META_SQLSERVER_PORT: "1433",
  META_SQLSERVER_DATABASE: "ai_bi_meta",
  META_SQLSERVER_USER: "api_user",
  META_SQLSERVER_PASSWORD: "secret",
  META_SQLSERVER_ENCRYPT: "true",
  META_SQLSERVER_TRUST_SERVER_CERTIFICATE: "false",
  API_JWT_SIGNING_PRIVATE_KEY_PEM: "test-private-key",
  API_JWT_VERIFICATION_PUBLIC_KEY_PEM: "test-public-key",
};

describe("API 启动配置", () => {
  // BDD 场景：部署使用 JSON 启动配置；TDD 断言：示例文件可被同一 Schema 加载。
  it("加载 JSON 配置文件", async () => {
    const config = loadApiConfig(
      fileURLToPath(new URL("../../config/api.config.example.json", import.meta.url)),
    );

    expect(config.service.service_id).toBe("ai-bi-api");
    expect(config.metadata_sqlserver.database).toBe("ai_bi_meta");
    expect(config.jwt.access_token_ttl_seconds).toBe(900);
  });

  // BDD 场景：配置文本损坏；TDD 断言：解析错误带有配置文件上下文。
  it("拒绝非法 JSON 配置", () => {
    expect(() => parseApiConfig("{")).toThrow("API 配置文件不是合法 JSON");
  });

  // BDD 场景：API 在测试环境启动；TDD 断言：环境变量转换为受控配置。
  it("解析服务和元数据库配置", () => {
    const config = parseApiEnvironment(validEnvironment);

    expect(config.service.port).toBe(3000);
    expect(config.metadata_sqlserver.options.pool.max).toBe(10);
  });

  // BDD 场景：部署缺少元数据库凭据；TDD 断言：配置加载立即失败。
  it("拒绝缺失元数据库必填项", () => {
    const environment = { ...validEnvironment, META_SQLSERVER_PASSWORD: "" };

    expect(() => parseApiEnvironment(environment)).toThrow("META_SQLSERVER_PASSWORD 不能为空");
  });

  // BDD 场景：连接池最小连接数超过最大连接数；TDD 断言：配置边界被拒绝。
  it("拒绝无效连接池范围", () => {
    const environment = {
      ...validEnvironment,
      META_SQLSERVER_POOL_MIN: "11",
      META_SQLSERVER_POOL_MAX: "10",
    };

    expect(() => parseApiEnvironment(environment)).toThrow(
      "metadata_sqlserver.options.pool.min 不能大于 max",
    );
  });
});
