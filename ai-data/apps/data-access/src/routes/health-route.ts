import type { FastifyInstance } from "fastify";

import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import type { DasConfig } from "../config/das-config";
import dayjs from "dayjs";

/** 以元数据库探测结果判断 DAS 健康状态，响应只含实例标识、版本和检查时间。 */
function registerHealthRoute(
  app: FastifyInstance,
  config: DasConfig,
  metadataDatabase: MetadataDatabaseHealthChecker,
): void {
  app.get("/health", async (_request, reply) => {
    const metadataDatabaseStatus = await metadataDatabase.checkHealth();
    const status = metadataDatabaseStatus === "healthy" ? "healthy" : "unhealthy";

    return reply.code(status === "healthy" ? 200 : 503).send({
      status,
      service_id: config.service.service_id,
      service_version: config.service.service_version,
      checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    });
  });
}

export { registerHealthRoute };
