import { z } from "zod";
import {
  datasetSchema,
  adminDatasetDetailSchema,
  apiDatasetConfigSchema,
  managedRoleSchema,
  relationGraphSchema,
  relationPublishInputSchema,
  catalogRelationSchema,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
/** 业务目录读取使用管理员入口，允许维护尚未对业务角色开放的对象。 */
class CatalogApi {
  constructor(private readonly request: Transport) {}
  async sources() {
    return z
      .object({
        items: z.array(
          z
            .object({
              source_id: z.string().min(1),
              status: z.enum(["healthy", "unhealthy", "unknown"]),
            })
            .strict(),
        ),
      })
      .strict()
      .parse(await this.request("/api/admin/catalog/sources")).items;
  }
  async roles() {
    return z
      .object({ items: z.array(managedRoleSchema) })
      .strict()
      .parse(await this.request("/api/admin/catalog/role-options")).items;
  }
  async datasets(source: string) {
    return z
      .object({ items: z.array(datasetSchema) })
      .strict()
      .parse(await this.request(`/api/admin/catalog/datasets/${encodeURIComponent(source)}`)).items;
  }
  async detail(source: string, object: string) {
    return adminDatasetDetailSchema.parse(
      await this.request(
        `/api/admin/catalog/datasets/${encodeURIComponent(source)}/${encodeURIComponent(object)}`,
      ),
    );
  }
  async save(value: unknown) {
    const body = apiDatasetConfigSchema
      .safeExtend({ expected_version: z.number().int().nonnegative() })
      .parse(value);
    z.undefined().parse(await this.request("/api/admin/catalog/datasets", { method: "PUT", body }));
  }
  async graph(source: string, object: string) {
    return relationGraphSchema.parse(
      await this.request(
        `/api/admin/catalog/${encodeURIComponent(source)}/objects/${encodeURIComponent(object)}/relations`,
      ),
    );
  }
  async publish(source: string, value: unknown) {
    return z
      .object({ items: z.array(catalogRelationSchema) })
      .strict()
      .parse(
        await this.request(`/api/admin/catalog/${encodeURIComponent(source)}/relations/publish`, {
          method: "POST",
          body: relationPublishInputSchema.parse(value),
        }),
      ).items;
  }
}
export { CatalogApi };
