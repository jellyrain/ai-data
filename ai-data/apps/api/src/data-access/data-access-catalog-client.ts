import { datasetSchema, type Dataset } from "@ai-data/contracts";
import { z } from "zod";
import type { DataAccessCatalogClient } from "./data-access-types";
import { requestDataAccess } from "./request-data-access";
import type { JwtService } from "../auth/jwt-service";

/** 校验 DAS 目录项；source_id 等响应摘要由实例选择和请求参数确定。 */
const catalogResponseSchema = z.object({ items: z.array(datasetSchema) });

/** 通过 DAS 的内部目录接口读取物理目录。 */
class HttpDataAccessCatalogClient implements DataAccessCatalogClient {
  constructor(private readonly jwt: Pick<JwtService, "signServiceRequest">) {}
  /** 重新校验远端数据，损坏的目录响应由传输适配器归为内部错误。 */
  async listCatalog(serviceUrl: string, sourceId: string, serviceId: string): Promise<Dataset[]> {
    const body = { source_id: sourceId };
    return requestDataAccess(
      `${serviceUrl.replace(/\/$/, "")}/internal/catalog`,
      body,
      (data) => catalogResponseSchema.parse(data).items,
      await this.jwt.signServiceRequest(
        serviceId,
        "das_catalog",
        "POST",
        "/internal/catalog",
        body,
      ),
    );
  }
}

export { HttpDataAccessCatalogClient };
