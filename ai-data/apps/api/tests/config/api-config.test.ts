import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  apiConfigSchema,
  loadApiConfig,
  parseApiConfig,
  parseApiEnvironment,
} from "../../src/config/api-config";

/** 独立环境变量输入，测试配置转换规则，不修改测试进程的实际环境。 */
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
  it("选择支持 Responses 的模型并使用独立运行时目录及有界工具预算", () => {
    const input = {
      enabled: true,
      active_provider: "local",
      providers: [
        {
          id: "local",
          protocol: "responses",
          base_url: "http://127.0.0.1:8000/v1",
          model: "custom-model",
        },
      ],
      context_window: 32768,
    };
    expect(apiConfigSchema.shape.analysis_runtime.parse(input)).toMatchObject({
      state_directory: "secrets/codex-runtime",
      max_tool_calls: 30,
      context_window: 32768,
    });
    expect(
      apiConfigSchema.shape.analysis_runtime.safeParse({ ...input, active_provider: "missing" })
        .success,
    ).toBe(false);
    expect(
      apiConfigSchema.shape.analysis_runtime.safeParse({ ...input, max_steps: 12 }).success,
    ).toBe(false);
    expect(
      apiConfigSchema.shape.analysis_runtime.safeParse({ ...input, max_output_tokens: 4096 })
        .success,
    ).toBe(false);
  });
  it("加载 JSON 配置文件", async () => {
    const config = loadApiConfig(
      fileURLToPath(new URL("../../config/api.config.example.json", import.meta.url)),
    );

    expect(config.service.service_id).toBe("ai-bi-api");
    expect(config.metadata_sqlserver.database).toBe("ai_bi_meta");
    expect(config.jwt.access_token_ttl_seconds).toBe(900);
  });

  it("拒绝非法 JSON 配置", () => {
    expect(() => parseApiConfig("{")).toThrow("API 配置文件不是合法 JSON");
  });

  it.each(["duplicate", "invalid-version"])("拒绝 %s 实例接入配置", (scenario) => {
    const config = parseApiEnvironment(validEnvironment);
    const service = {
      service_id: "das",
      credential_version: scenario === "invalid-version" ? 0 : 1,
      enabled: true,
    };
    expect(() =>
      parseApiConfig(
        JSON.stringify({
          ...config,
          trusted_data_access_services: scenario === "duplicate" ? [service, service] : [service],
        }),
      ),
    ).toThrow();
  });

  it("解析服务和元数据库配置", () => {
    const config = parseApiEnvironment(validEnvironment);

    expect(config.service.port).toBe(3000);
    expect(config.metadata_sqlserver.options.pool.max).toBe(10);
  });

  it("拒绝缺失元数据库必填项", () => {
    const environment = { ...validEnvironment, META_SQLSERVER_PASSWORD: "" };

    expect(() => parseApiEnvironment(environment)).toThrow("META_SQLSERVER_PASSWORD 不能为空");
  });

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
