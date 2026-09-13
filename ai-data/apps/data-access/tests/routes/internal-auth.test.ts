import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { parseDasConfig } from "../../src/config/das-config";
import { createServiceToken, createServiceVerifier } from "../support/service-auth-fixtures";

/** 仅用于路由边界验证，依赖替身不会访问实际数据源。 */
const config = parseDasConfig(
  JSON.stringify({
    service: {
      host: "127.0.0.1",
      port: 3102,
      service_id: "data-access-test",
      service_version: "1",
    },
    api: {
      base_url: "http://localhost:3101",
      heartbeat_path: "/internal/data-access/heartbeat",
      registration_credential_path: "test-registration.jwt",
      jwt_verification_public_key_path: "test.pem",
    },
    metadata_sqlserver: {
      server: "localhost",
      port: 1433,
      database: "test",
      user: "test",
      password: "test",
      options: {
        encrypt: false,
        trust_server_certificate: true,
        connection_timeout_ms: 1000,
        request_timeout_ms: 1000,
        pool: { max: 1, min: 0, idle_timeout_ms: 1000 },
      },
    },
  }),
);

describe("DAS 内部入口认证", () => {
  describe.each([
    ["POST", "/internal/catalog"],
    ["POST", "/internal/admin/data-source-secrets"],
    ["POST", "/internal/admin/database-targets"],
    ["PUT", "/internal/admin/data-sources"],
    ["POST", "/internal/admin/data-source-objects/discover"],
    ["PUT", "/internal/admin/data-source-objects"],
  ] as const)("%s %s", (method, url) => {
    it.each(["valid", "missing", "invalid", "wrong-purpose", "tampered-body"])(
      "校验 %s 凭据后决定是否调用业务",
      async (scenario) => {
        const called = vi.fn();
        const app = createApp(
          config,
          { checkHealth: async () => "healthy" },
          {
            listBySourceId: async () => {
              called();
              return [];
            },
          },
          {
            saveSharedCredentials: async () => {
              called();
              return { secret_ref: "test" };
            },
            discoverDatabaseTargets: async () => {
              called();
              return { databases: [] };
            },
            saveDataSource: async () => {
              called();
              return { source_id: "test" };
            },
            discoverSourceObjects: async () => {
              called();
              return { items: [] };
            },
            replaceSourceObjects: async () => {
              called();
              return { source_id: "test", object_count: 0 };
            },
          },
          undefined,
          undefined,
          await createServiceVerifier(),
        );
        app.log.level = "silent";
        try {
          const body = { source_id: "test" };
          const token =
            scenario === "invalid"
              ? "invalid"
              : await createServiceToken(
                  method,
                  url,
                  body,
                  scenario === "wrong-purpose" ? { token_use: "das_query" } : {},
                );
          const response = await app.inject({
            method,
            url,
            headers: scenario === "missing" ? {} : { authorization: `Bearer ${token}` },
            payload: scenario === "tampered-body" ? { source_id: "changed" } : body,
          });
          expect(response.statusCode).toBe(
            scenario === "valid" ? 200 : scenario === "missing" ? 401 : 403,
          );
          expect(called).toHaveBeenCalledTimes(scenario === "valid" ? 1 : 0);
        } finally {
          await app.close();
        }
      },
    );
  });
});
