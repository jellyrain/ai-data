import dayjs from "dayjs";
import type { FastifyInstance } from "fastify";
import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import type { ApiConfig } from "../config/api-config";

/** 注册 API 存活、就绪和版本诊断接口。 */
function registerSystemRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  metadataDatabase: MetadataDatabaseHealthChecker,
): void {
  // 存活探针只说明进程可响应，就绪探针另行检查元数据库。
  app.get("/health", async (_request, reply) => {
    return reply.send({
      status: "healthy",
      service_id: config.service.service_id,
      service_version: config.service.service_version,
      checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    });
  });

  app.get("/ready", async (_request, reply) => {
    const metadataStatus = await metadataDatabase.checkHealth();
    const status = metadataStatus === "healthy" ? "ready" : "not_ready";
    return reply.code(status === "ready" ? 200 : 503).send({
      status,
      service_id: config.service.service_id,
      service_version: config.service.service_version,
      dependencies: { metadata_database: metadataStatus },
      checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    });
  });

  app.get("/version", async (_request, reply) => {
    return reply.send({
      service_id: config.service.service_id,
      service_version: config.service.service_version,
    });
  });
}

export { registerSystemRoutes };
