import { describe, expect, it, vi } from "vitest";
import { DataSourceLifecycle } from "../../src/data-access/data-source-lifecycle";
import { ApplicationError } from "../../src/errors/application-error";

const input = {
  source_id: "危急值数据",
  expected_revision: "a".repeat(64),
  expected_objects_revision: "b".repeat(64),
};
function fixture() {
  const config = {
    source_id: input.source_id,
    connector_kind: "sqlserver",
    secret_ref: "业务库",
    target_database: "demo",
    is_enabled: true,
    timeout_ms: 30000,
    connection_pool_limit: 5,
    concurrency_limit: 5,
    row_limit: 10000,
    cost_limit: 1,
  };
  let exists = true;
  const clear = vi.fn(async () => {});
  const client = {
    read: vi.fn(async () => ({ config: exists ? config : null, revision: "c".repeat(64) })),
    execute: vi.fn(async () => {
      exists = false;
      return { source_id: input.source_id };
    }),
  };
  const registry = { listRegisteredServices: vi.fn(async () => []) };
  const store = {
    run: async <T>(_id: string, operation: (clear: () => Promise<void>) => Promise<T>) =>
      operation(clear),
  };
  const service = new DataSourceLifecycle({ client, registry, store });
  return {
    config,
    service,
    client,
    registry,
    clear,
    absent: () => {
      exists = false;
    },
  };
}
describe("数据源删除同时清理 API 当前配置", () => {
  it("DAS 删除并确认不存在后，才清理 API 配置并返回成功", async () => {
    const f = fixture();
    f.clear.mockImplementation(async () => {
      expect((await f.client.read()).config).toBeNull();
    });
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).resolves.toEqual({ source_id: input.source_id });
    expect(f.clear).toHaveBeenCalledOnce();
    expect(f.client.execute).toHaveBeenCalledWith(
      "das",
      "http://das",
      "data-sources/delete",
      input,
    );
  });
  it("版本冲突且源仍存在时，保留 API 配置", async () => {
    const f = fixture();
    f.client.execute.mockRejectedValue(new ApplicationError("CONFLICT", "版本冲突"));
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.clear).not.toHaveBeenCalled();
  });
  it("DAS 回执丢失时，确认源已消失后继续 API 清理", async () => {
    const f = fixture();
    f.client.execute.mockImplementation(async () => {
      f.absent();
      throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "回执丢失");
    });
    await f.service.execute("das", "http://das", "data-sources/delete", input);
    expect(f.clear).toHaveBeenCalledOnce();
  });
  it("API 清理失败不报成功，重试已删除的源可补完清理", async () => {
    const f = fixture();
    f.clear.mockRejectedValueOnce(new Error("元数据库不可写"));
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).rejects.toThrow();
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).resolves.toEqual({ source_id: input.source_id });
    expect(f.client.execute).toHaveBeenCalledOnce();
    expect(f.clear).toHaveBeenCalledTimes(2);
  });
  it("读取不可达时不凭猜测清理", async () => {
    const f = fixture();
    f.client.read.mockRejectedValue(new ApplicationError("DATA_SOURCE_UNAVAILABLE", "不可达"));
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).rejects.toThrow();
    expect(f.clear).not.toHaveBeenCalled();
    expect(f.client.execute).not.toHaveBeenCalled();
  });
  it("另一个 DAS 仍登记同名源时，拒绝删除以保护共用目录", async () => {
    const f = fixture();
    f.registry.listRegisteredServices.mockResolvedValue([
      { serviceId: "other", sources: [{ source_id: input.source_id }] },
    ] as never);
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
  });
  it("读取到别的源或删除后同名源仍存在时拒绝清理", async () => {
    const f = fixture();
    f.client.execute.mockImplementation(async () => ({ source_id: input.source_id }));
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.clear).not.toHaveBeenCalled();
    f.client.read.mockResolvedValue({
      config: { ...f.config, source_id: "另一个源" },
      revision: "c".repeat(64),
    });
    await expect(
      f.service.execute("das", "http://das", "data-sources/delete", input),
    ).rejects.toThrow();
    expect(f.clear).not.toHaveBeenCalled();
  });
});
