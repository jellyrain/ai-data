import axios, { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataAccessQueryRequestSchema } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { DataAccessQueryClient } from "../../src/data-access/data-access-query-client";
import { HttpDataAccessCatalogClient } from "../../src/data-access/data-access-catalog-client";
import type { DataAccessServiceRegistry } from "../../src/data-access/data-access-types";
import { RegisteredDataAccessCatalog } from "../../src/catalog/registered-data-access-catalog";
import { SqlCatalogRepository } from "../../src/catalog/sql-catalog-repository";
import { SqlDataAccessServiceRegistry } from "../../src/data-access/sql-data-access-service-registry";

afterEach(() => vi.restoreAllMocks());

/** 用合法签名载荷形状隔离客户端传输行为；本组测试不执行 DAS 验签。 */
const input = {
  token: "internal-token",
  request: dataAccessQueryRequestSchema.parse({
    access: {
      user_id: "user",
      organization_id: "org",
      analysis_run_id: "run",
      policy_version: 1,
      expires_at: "2026-09-11 12:00:00",
    },
    query: {
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "clinical.visit", alias: "v" },
      select: [{ field: "v.id" }],
    },
    signature: "signature",
  }),
};

/** 健康注册实例与客户端请求使用同一 source_id，避免绕过实例选择路径。 */
function registry(healthy = true): DataAccessServiceRegistry {
  return {
    registerHeartbeat: async () => {
      throw new Error("测试不接收心跳");
    },
    listHealthyServices: async () =>
      healthy
        ? [
            {
              serviceId: "das",
              serviceUrl: "http://das:3102",
              serviceVersion: "1",
              status: "healthy",
              lastHeartbeatAt: new Date(),
              message: null,
              sources: [
                { source_id: "clinical", status: "healthy", checked_at: "2026-09-11 12:00:00" },
              ],
            },
          ]
        : [],
  };
}

/** 构造完整 Axios 响应，只替换远端返回状态和数据。 */
function response(data: unknown, status = 200): AxiosResponse<unknown> {
  return { data, status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() } };
}

describe("DAS 错误适配", () => {
  it("查询把取消信号交给 HTTP 传输并拒绝晚到结果", async () => {
    const controller = new AbortController();
    const post = vi.spyOn(axios, "post").mockImplementation(async () => {
      controller.abort();
      return response({ columns: [], rows: [], row_count: 0, truncated: false });
    });
    await expect(
      new DataAccessQueryClient(registry()).execute(input, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      input.request,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("传输取消使用 CANCELLED 错误并清理请求凭据", async () => {
    const cause = new AxiosError("cancelled", "ERR_CANCELED", {
      headers: new AxiosHeaders({ authorization: "private-token" }),
    });
    vi.spyOn(axios, "post").mockRejectedValue(cause);
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(cause.config).toBeUndefined();
  });

  it("内部请求失败保留传输原因，但日志序列化不会带出令牌或管理凭据", async () => {
    const cause = new AxiosError(
      "connection refused",
      "ECONNREFUSED",
      {
        headers: new AxiosHeaders({ authorization: "Bearer private-service-token" }),
        data: JSON.stringify({ password: "private-database-password" }),
      },
      { authorization: "Bearer private-service-token" },
    );
    vi.spyOn(axios, "post").mockRejectedValue(cause);
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toMatchObject({
      cause,
    });
    expect(JSON.stringify(cause)).not.toContain("private-service-token");
    expect(JSON.stringify(cause)).not.toContain("private-database-password");
    expect(cause.request).toBeUndefined();
  });

  it("Axios 配置错误保留为内部故障而不是数据源不可用", async () => {
    const cause = new AxiosError("invalid-option", "ERR_BAD_OPTION_VALUE");
    vi.spyOn(axios, "post").mockRejectedValue(cause);
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toBe(cause);
  });

  it("查询和原始目录都把无健康实例表达为数据源不可用", async () => {
    await expect(new DataAccessQueryClient(registry(false)).execute(input)).rejects.toMatchObject({
      code: "DATA_SOURCE_UNAVAILABLE",
    });
    await expect(
      new RegisteredDataAccessCatalog(
        registry(false),
        new HttpDataAccessCatalogClient({ signServiceRequest: async () => "service-token" }),
      ).listRawCatalog("clinical"),
    ).rejects.toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
  });

  it.each([
    ["ECONNREFUSED", "DATA_SOURCE_UNAVAILABLE"],
    ["ECONNABORTED", "QUERY_TIMEOUT"],
    ["ETIMEDOUT", "QUERY_TIMEOUT"],
  ])("查询和目录将传输异常 %s 分类为 %s 并保留原因", async (transportCode, code) => {
    const cause = new AxiosError("upstream-secret", transportCode);
    vi.spyOn(axios, "post").mockRejectedValue(cause);
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toMatchObject({
      code,
      cause,
    });
    await expect(
      new HttpDataAccessCatalogClient({
        signServiceRequest: async () => "service-token",
      }).listCatalog("http://das", "clinical", "das"),
    ).rejects.toMatchObject({ code, cause });
  });

  it.each([
    ["UNAUTHORIZED_COLUMN", "UNAUTHORIZED_COLUMN"],
    ["QUERY_TIMEOUT", "QUERY_TIMEOUT"],
    ["AUTHENTICATION_FAILED", "INTERNAL_ERROR"],
  ])("DAS 返回 %s 时 API 输出 %s", async (upstream, code) => {
    vi.spyOn(axios, "post").mockResolvedValue(
      response({ code: upstream, message: "upstream-secret" }, 403),
    );
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toMatchObject({
      code,
    });
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.not.toHaveProperty(
      "message",
      "upstream-secret",
    );
  });

  it.each([503, 502])("DAS 返回非合同 HTTP %i 时报告不可用", async (status) => {
    vi.spyOn(axios, "post").mockResolvedValue(response("proxy-secret", status));
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toMatchObject({
      code: "DATA_SOURCE_UNAVAILABLE",
    });
  });

  it("DAS 的成功响应不符合合同属于内部数据错误", async () => {
    vi.spyOn(axios, "post").mockResolvedValue(response({ items: [{}] }));
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      cause: expect.any(Error),
    });
    await expect(
      new HttpDataAccessCatalogClient({
        signServiceRequest: async () => "service-token",
      }).listCatalog("http://das", "clinical", "das"),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", cause: expect.any(Error) });
  });

  it("查询和目录的合法成功结果继续正常返回", async () => {
    const result = { columns: [], rows: [], row_count: 0, truncated: false };
    const post = vi
      .spyOn(axios, "post")
      .mockResolvedValueOnce(response(result))
      .mockResolvedValueOnce(response({ items: [] }));
    await expect(new DataAccessQueryClient(registry()).execute(input)).resolves.toEqual(result);
    await expect(
      new HttpDataAccessCatalogClient({
        signServiceRequest: async () => "service-token",
      }).listCatalog("http://das", "clinical", "das"),
    ).resolves.toEqual([]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("未知编程异常保留原对象交给统一错误出口", async () => {
    const cause = new TypeError("unexpected");
    vi.spyOn(axios, "post").mockRejectedValue(cause);
    await expect(new DataAccessQueryClient(registry()).execute(input)).rejects.toBe(cause);
  });
});

describe("持久化目录配置的错误适配", () => {
  it.each(["{", "{}", "[{}]"])("DAS 注册快照 %s 损坏时返回内部错误", async (sources_json) => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ sources_json }], rowsAffected: [] });
    await expect(
      new SqlDataAccessServiceRegistry({ execute }).listHealthyServices(),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      cause: expect.any(Error),
    });
  });

  it.each(["{", "{}"])("已存储配置 %s 损坏时标记为内部错误", async (config_json) => {
    // 数据库接口由调用方指定记录类型；固定坏记录用于验证读取边界的运行时校验。
    const execute = vi.fn().mockResolvedValue({ rows: [{ config_json }], rowsAffected: [] });
    const database: MetadataQueryExecutor = { execute };
    const repository = new SqlCatalogRepository(database);
    await expect(repository.find("clinical", "visit")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      cause: expect.any(Error),
    });
    await expect(repository.listBySourceId("clinical")).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      cause: expect.any(Error),
    });
  });
});
