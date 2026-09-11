import axios from "axios";
import { datasetSchema, type Dataset } from "@ai-data/contracts";

import type { DataAccessCatalogClient } from "./data-access-types";

/** 调用 DAS `/internal/catalog` 的轻量 HTTP Client。 */
class HttpDataAccessCatalogClient implements DataAccessCatalogClient {
  /** 请求目录并在 API 边界重新校验 DAS 返回合同。 */
  async listCatalog(serviceUrl: string, sourceId: string): Promise<Dataset[]> {
    const response = await axios.post<unknown>(
      `${serviceUrl.replace(/\/$/, "")}/internal/catalog`,
      { source_id: sourceId },
      { headers: { "content-type": "application/json" } },
    );
    const body = response.data;
    if (!body || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) {
      throw new Error("DAS 目录响应格式无效");
    }
    return body.items.map((item) => datasetSchema.parse(item));
  }
}

export { HttpDataAccessCatalogClient };
