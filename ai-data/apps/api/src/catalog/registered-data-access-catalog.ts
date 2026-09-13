import type { Dataset } from "@ai-data/contracts";

import type {
  DataAccessCatalogClient,
  DataAccessServiceRegistry,
} from "../data-access/data-access-types";
import type { RawCatalogReader } from "./catalog-types";
import { ApplicationError } from "../errors/application-error";

/** 只从登记且健康的数据源实例读取 DAS 原始目录。 */
class RegisteredDataAccessCatalog implements RawCatalogReader {
  constructor(
    private readonly registry: Pick<DataAccessServiceRegistry, "listHealthyServices">,
    private readonly client: DataAccessCatalogClient,
  ) {}

  /** 为 source_id 选择第一个健康 DAS 实例并读取其目录。 */
  async listRawCatalog(sourceId: string): Promise<Dataset[]> {
    const service = (await this.registry.listHealthyServices()).find((item) =>
      item.sources.some((source) => source.source_id === sourceId && source.status === "healthy"),
    );
    if (!service) throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "没有可用的 DAS 数据源");
    return this.client.listCatalog(service.serviceUrl, sourceId, service.serviceId);
  }
}

export { RegisteredDataAccessCatalog };
