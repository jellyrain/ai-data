import type { FastifyInstance } from "fastify";
import { dataAccessHeartbeatSchema } from "@ai-data/contracts";
import dayjs from "dayjs";

import type {
  DataAccessCatalogClient,
  DataAccessServiceRegistry,
} from "../data-access/data-access-types";

/** 从心跳 TCP 连接的远端地址和 DAS 上报端口生成 API 的内部调用地址。 */
function deriveDataAccessServiceUrl(
  remoteAddress: string | undefined,
  servicePort: number,
  serviceProtocol: "http" | "https",
): string | null {
  if (!remoteAddress) return null;
  const address = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress === "::1"
      ? "127.0.0.1"
      : remoteAddress.replace(/%.+$/, "");
  return address.includes(":")
    ? `${serviceProtocol}://[${address}]:${servicePort}`
    : `${serviceProtocol}://${address}:${servicePort}`;
}

/** 注册 DAS 心跳接收和目录读取接口。 */
function registerDataAccessRoutes(
  app: FastifyInstance,
  registry: DataAccessServiceRegistry,
  catalogClient: DataAccessCatalogClient,
): void {
  /** DAS 定时调用此接口，API 不信任请求中的用户身份字段。 */
  app.post("/internal/data-access/heartbeat", async (request, reply) => {
    const parsed = dataAccessHeartbeatSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "INVALID_INPUT", message: "DAS 心跳格式无效" });
    const serviceUrl = deriveDataAccessServiceUrl(
      request.socket.remoteAddress,
      parsed.data.service_port,
      parsed.data.service_protocol,
    );
    if (!serviceUrl)
      return reply.code(400).send({ code: "INVALID_INPUT", message: "无法识别 DAS 心跳来源地址" });
    const registration = await registry.registerHeartbeat(parsed.data, serviceUrl);
    return reply.send({
      service_id: registration.serviceId,
      accepted_at: dayjs(registration.lastHeartbeatAt).format("YYYY-MM-DD HH:mm:ss"),
    });
  });

  /** 返回 API 当前登记的健康 DAS 实例，供管理端诊断。 */
  app.get("/internal/data-access/services", async (_request, reply) => {
    const services = await registry.listHealthyServices();
    return reply.send({
      items: services.map((service) => ({
        service_id: service.serviceId,
        service_url: service.serviceUrl,
        service_version: service.serviceVersion,
        status: service.status,
        last_heartbeat_at: dayjs(service.lastHeartbeatAt).format("YYYY-MM-DD HH:mm:ss"),
        sources: service.sources,
      })),
    });
  });

  /** 按健康 DAS 实例读取指定 source_id 的物理目录。 */
  app.get<{ Params: { sourceId: string } }>(
    "/internal/data-access/catalog/:sourceId",
    async (request, reply) => {
      const services = await registry.listHealthyServices();
      const service = services.find((item) =>
        item.sources.some(
          (source) => source.source_id === request.params.sourceId && source.status === "healthy",
        ),
      );
      if (!service)
        return reply
          .code(503)
          .send({ code: "DATA_ACCESS_UNAVAILABLE", message: "没有可用的 DAS 数据源" });
      return reply.send({
        source_id: request.params.sourceId,
        service_id: service.serviceId,
        items: await catalogClient.listCatalog(service.serviceUrl, request.params.sourceId),
      });
    },
  );
}

export { deriveDataAccessServiceUrl, registerDataAccessRoutes };
