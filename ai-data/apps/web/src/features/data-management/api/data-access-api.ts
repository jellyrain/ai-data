import { z } from "zod";
import {
  managedDataAccessServiceSchema,
  managedDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSecretReferenceSchema,
  managedSourceObjectsSchema,
  manageableSourceObjectSchema,
  databaseTargetSchema,
  sharedDatabaseCredentialsSchema,
  dataSourceManagementConfigSchema,
  databaseTargetDiscoveryRequestSchema,
  sourceObjectSelectionRequestSchema,
  managedSqlServerTransportSchema,
  sqlServerTransportUpdateSchema,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
import { ApiError } from "../../../shared/http/api-error";
/** 浏览器只访问 API 的已授权管理代理，所有返回都按公开合同校验。 */
class DataAccessApi {
  private readonly path: string;
  constructor(
    private readonly request: Transport,
    serviceId: string,
  ) {
    this.path = `/api/admin/data-access/services/${encodeURIComponent(serviceId)}`;
  }
  async services() {
    return z
      .object({ items: z.array(managedDataAccessServiceSchema) })
      .strict()
      .parse(await this.request("/api/admin/data-access/services")).items;
  }
  async credential() {
    return z
      .object({ service_id: z.string().min(1), credential: z.string().min(1) })
      .strict()
      .parse(await this.request(`${this.path}/credential`, { method: "POST", body: {} }));
  }
  async sources() {
    return z
      .object({ items: z.array(managedDataSourceSchema) })
      .strict()
      .parse(await this.request(`${this.path}/data-sources`)).items;
  }
  async source(id: string) {
    return managedDataSourceDetailSchema.parse(
      await this.request(`${this.path}/data-sources/${encodeURIComponent(id)}`),
    );
  }
  async secrets() {
    return z
      .object({ items: z.array(managedSecretReferenceSchema) })
      .strict()
      .parse(await this.request(`${this.path}/data-source-secrets`)).items;
  }
  async sqlServerTransport(secretRef: string) {
    return managedSqlServerTransportSchema.parse(
      await this.request(
        `${this.path}/data-source-secrets/${encodeURIComponent(secretRef)}/sqlserver-transport`,
      ),
    );
  }
  async saveSqlServerTransport(secretRef: string, input: unknown) {
    const response = await this.request(
      `${this.path}/data-source-secrets/${encodeURIComponent(secretRef)}/sqlserver-transport`,
      {
        method: "PUT",
        body: sqlServerTransportUpdateSchema.parse(input),
      },
    );
    const parsed = managedSqlServerTransportSchema.safeParse(response);
    if (!parsed.success)
      throw new ApiError("连接参数保存回执无效，请核对实际状态", 502, "INVALID_RECEIPT");
    return parsed.data;
  }
  async objects(id: string) {
    return managedSourceObjectsSchema.parse(
      await this.request(`${this.path}/data-source-objects/${encodeURIComponent(id)}`),
    );
  }
  async saveSecret(value: unknown) {
    return z
      .object({ secret_ref: z.string().min(1) })
      .strict()
      .parse(
        await this.request(`${this.path}/data-source-secrets`, {
          method: "POST",
          body: sharedDatabaseCredentialsSchema.parse(value),
        }),
      );
  }
  async targets(value: unknown) {
    return z
      .object({ databases: z.array(databaseTargetSchema) })
      .strict()
      .parse(
        await this.request(`${this.path}/database-targets`, {
          method: "POST",
          body: databaseTargetDiscoveryRequestSchema.parse(value),
          timeoutMs: 130000,
        }),
      ).databases;
  }
  async saveSource(value: unknown) {
    return z
      .object({ source_id: z.string().min(1) })
      .strict()
      .parse(
        await this.request(`${this.path}/data-sources`, {
          method: "PUT",
          body: dataSourceManagementConfigSchema.parse(value),
        }),
      );
  }
  async discover(id: string) {
    return z
      .object({ items: z.array(manageableSourceObjectSchema) })
      .strict()
      .parse(
        await this.request(`${this.path}/data-source-objects/discover`, {
          method: "POST",
          body: { source_id: id },
          timeoutMs: 130000,
        }),
      ).items;
  }
  async saveObjects(value: unknown) {
    return z
      .object({ source_id: z.string().min(1), object_count: z.number().int().nonnegative() })
      .strict()
      .parse(
        await this.request(`${this.path}/data-source-objects`, {
          method: "PUT",
          body: sourceObjectSelectionRequestSchema.parse(value),
          timeoutMs: 130000,
        }),
      );
  }
}
export { DataAccessApi };
