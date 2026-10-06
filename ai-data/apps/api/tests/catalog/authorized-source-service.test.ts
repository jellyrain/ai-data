import { describe, expect, it, vi } from "vitest";
import type { DataAccessServiceRegistration } from "../../src/data-access/data-access-types";
import { AuthorizedSourceService } from "../../src/catalog/authorized-source-service";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

describe("编辑器的可用数据源", () => {
  function setup() {
    const registry = {
      listHealthyServices: vi.fn(
        async () =>
          [
            {
              sources: [
                { source_id: "c", status: "healthy" },
                { source_id: "a", status: "healthy" },
                { source_id: "hidden", status: "healthy" },
                { source_id: "offline", status: "unhealthy" },
              ],
            },
            {
              sources: [
                { source_id: "a", status: "healthy" },
                { source_id: "b", status: "healthy" },
              ],
            },
          ] as DataAccessServiceRegistration[],
      ),
    };
    const catalog = {
      listAuthorized: vi.fn(async (_identity: unknown, id: string) =>
        id === "hidden" ? [] : [{ dataset: { object_id: "table" } }],
      ),
    };
    return { registry, catalog, service: new AuthorizedSourceService({ registry, catalog }) };
  }
  it("健康源去重排序，仅返回当前身份有可见对象的源，翻页重新授权", async () => {
    const h = setup();
    expect(await h.service.list(context, { limit: 2 })).toEqual({
      items: [{ source_id: "a" }, { source_id: "b" }],
      next_cursor: "b",
    });
    expect(await h.service.list(context, { limit: 2, cursor: "b" })).toEqual({
      items: [{ source_id: "c" }],
    });
    expect(h.catalog.listAuthorized).toHaveBeenCalledWith(context, "a");
    expect(h.catalog.listAuthorized).not.toHaveBeenCalledWith(context, "offline");
  });
  it("目录故障原样报告，不作为成功空列表", async () => {
    const h = setup();
    h.catalog.listAuthorized.mockRejectedValueOnce(
      new ApplicationError("DATA_SOURCE_UNAVAILABLE", "目录读取失败"),
    );
    await expect(h.service.list(context, {})).rejects.toMatchObject({
      code: "DATA_SOURCE_UNAVAILABLE",
    });
  });
});
