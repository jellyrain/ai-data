import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CatalogReader } from "../catalog/catalog-service";
import { sendInvalidInput } from "./contract-error";
import { internalServiceAuth } from "./internal-auth";
import type { InternalServiceVerifier } from "../auth/internal-service-verifier";

/** 内部目录请求只接受 source_id，用于选择待发现的数据源。 */
const catalogRequestSchema = z
  .object({
    /** DAS 内部数据源配置标识。 */
    source_id: z.string().min(1),
  })
  .strict();

/** 注册供 API 读取已筛选目录的 DAS 内部接口。 */
function registerCatalogRoute(
  app: FastifyInstance,
  catalogReader: CatalogReader,
  verifier?: Pick<InternalServiceVerifier, "verify">,
): void {
  app.post(
    "/internal/catalog",
    { preHandler: internalServiceAuth("das_catalog", verifier) },
    async (request, reply) => {
      const parsed = catalogRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendInvalidInput(reply, request, "目录请求格式无效");
      }

      const items = await catalogReader.listBySourceId(parsed.data.source_id);
      return reply.send({ items });
    },
  );
}

export { registerCatalogRoute };
