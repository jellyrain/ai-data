import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CatalogReader } from "../catalog/catalog-service";
import { sendInvalidInput } from "./contract-error";

/** API 请求一个数据源目录的内部请求结构。 */
const catalogRequestSchema = z
  .object({
    /** DAS 内部数据源配置标识。 */
    source_id: z.string().min(1),
  })
  .strict();

/** 注册供 API 读取已筛选目录的 DAS 内部接口。 */
function registerCatalogRoute(app: FastifyInstance, catalogReader: CatalogReader): void {
  app.post("/internal/catalog", async (request, reply) => {
    const parsed = catalogRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendInvalidInput(reply, request, "目录请求格式无效");
    }

    const items = await catalogReader.listBySourceId(parsed.data.source_id);
    return reply.send({ items });
  });
}

export { registerCatalogRoute };
