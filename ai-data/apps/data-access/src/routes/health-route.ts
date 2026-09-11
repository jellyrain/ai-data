import type { FastifyInstance } from "fastify";

import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import type { DasConfig } from "../config/das-config";
import dayjs from "dayjs";

/** 注册不包含数据源凭据或业务数据的 DAS 服务健康检查。 */
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
