import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JwtService } from "../../src/auth/jwt-service";
import { BusinessCatalogService } from "../../src/catalog/business-catalog-service";
import { QueryAuthorizationService } from "../../src/query/query-authorization-service";
import { config, context, createApiDependencies } from "../support/api-fixtures";

describe("API 查询授权截止时间", () => {
  afterEach(() => vi.useRealTimers());

  it("按东八区签发 55 秒截止时间", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T04:00:00Z"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = await JwtService.create({
      ...config,
      jwt: {
        ...config.jwt,
        signing_private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        verification_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    });
    const dependencies = createApiDependencies();
    const catalog = new BusinessCatalogService(
      {
        listRawCatalog: async () => [
          {
            source_id: "clinical",
            object_id: "visit",
            name: "visit",
            kind: "table",
            columns: [{ name: "id", data_type: "integer", nullable: false }],
            query_parameters: [],
          },
        ],
      },
      { find: async () => null, listBySourceId: async () => [], save: async () => {} },
      dependencies.catalog.permissions,
    );
    const service = new QueryAuthorizationService(catalog, jwt);
    const { request } = await service.authorize(
      {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visit", alias: "v" },
        select: [{ field: "v.id" }],
      },
      context,
    );

    expect(request.access.expires_at).toBe("2026-09-13 12:00:55");
  });
});
