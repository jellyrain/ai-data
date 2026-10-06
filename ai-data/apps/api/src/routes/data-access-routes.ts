import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { dataAccessHeartbeatSchema, dataAccessSessionSchema } from "@ai-data/contracts";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import { sendInvalidInput } from "./contract-error";

import type { ApiAuthService, ApiDependencies } from "../app-types";
import { bearerToken } from "./auth-routes";
import { managementOperations } from "../data-access/data-access-management-client";

dayjs.extend(utc);

/** 实例接入凭证涉及服务信任配置，领取仅限系统管理员。 */
async function requireServiceAdmin(
  request: FastifyRequest,
  auth: ApiAuthService,
  credentials = false,
): Promise<void> {
  const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
  if (
    !context.roles.includes("system_admin") &&
    (credentials || !context.permissions.includes("data-access:manage"))
  )
    throw new ApplicationError("UNAUTHORIZED", "无数据访问服务管理权限");
}

/** 从心跳连接地址和 DAS 上报端口生成回调 URL；处理 IPv4 映射地址、IPv6 回环与作用域后缀。 */
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

/** 装配实例接入、会话心跳及由 API 授权的诊断和管理入口。 */
function registerDataAccessRoutes(
  app: FastifyInstance,
  dataAccess: ApiDependencies["dataAccess"],
  auth: ApiAuthService,
): void {
  const { registry, catalogClient, managementClient } = dataAccess;
  app.get("/admin/data-access/services", async (request, reply) => {
    reply.header("cache-control", "no-store");
    await requireServiceAdmin(request, auth);
    z.object({}).strict().parse(request.query);
    return {
      items: (await registry.listRegisteredServices()).map((service) => ({
        service_id: service.serviceId,
        service_url: service.serviceUrl,
        service_version: service.serviceVersion,
        status: service.status,
        connection_status: service.connectionStatus,
        last_heartbeat_at: dayjs(service.lastHeartbeatAt)
          .utcOffset(8)
          .format("YYYY-MM-DD HH:mm:ss"),
        sources: service.sources,
      })),
    };
  });
  const serviceParams = z.object({ serviceId: z.string().min(1).max(128) }).strict();
  const sourceParams = serviceParams.extend({ sourceId: z.string().min(1).max(128) }).strict();
  for (const method of ["GET", "PUT"] as const) {
    app.route({
      method,
      url: "/admin/data-access/services/:serviceId/data-source-secrets/:secretRef/sqlserver-transport",
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        await requireServiceAdmin(request, auth);
        z.object({}).strict().parse(request.query);
        const input = serviceParams
          .extend({ secretRef: z.string().min(1).max(256) })
          .strict()
          .parse(request.params);
        const service = (await registry.listHealthyServices()).find(
          (item) => item.serviceId === input.serviceId,
        );
        if (!service)
          throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "DAS 实例尚未注册或不可用");
        return managementClient.sqlServerTransport(
          service.serviceId,
          service.serviceUrl,
          input.secretRef,
          method,
          method === "PUT" ? request.body : undefined,
        );
      },
    });
  }
  for (const [suffix, operation] of [
    ["data-sources", "sources"],
    ["data-sources/:sourceId", "source"],
    ["data-source-objects/:sourceId", "objects"],
    ["data-source-secrets", "secrets"],
  ] as const) {
    app.get(`/admin/data-access/services/:serviceId/${suffix}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      await requireServiceAdmin(request, auth);
      z.object({}).strict().parse(request.query);
      const input = suffix.includes(":sourceId")
        ? sourceParams.parse(request.params)
        : serviceParams.parse(request.params);
      const service = (await registry.listHealthyServices()).find(
        (item) => item.serviceId === input.serviceId,
      );
      if (!service)
        throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "DAS 实例尚未注册或不可用");
      return reply.send(
        await managementClient.read(
          service.serviceId,
          service.serviceUrl,
          operation,
          "sourceId" in input ? z.string().parse(input.sourceId) : undefined,
        ),
      );
    });
  }
  // 注册绑定实际来源地址、端口和协议；心跳逐次核对该绑定。
  const receive =
    (registration: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const token = bearerToken(request);
      const parsed = dataAccessHeartbeatSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidInput(reply, request, "DAS 心跳格式无效");
      const serviceUrl = deriveDataAccessServiceUrl(
        request.socket.remoteAddress,
        parsed.data.service_port,
        parsed.data.service_protocol,
      );
      if (!serviceUrl) return sendInvalidInput(reply, request, "无法识别 DAS 心跳来源地址");
      if (registration) {
        const session = await registry.register(parsed.data, serviceUrl, token);
        reply.header("cache-control", "no-store");
        return reply.send(dataAccessSessionSchema.parse(session));
      }
      await registry.heartbeat(parsed.data, serviceUrl, token);
      return reply.send({
        service_id: parsed.data.service_id,
        accepted_at: dayjs().utcOffset(8).format("YYYY-MM-DD HH:mm:ss"),
      });
    };
  app.post("/internal/data-access/register", receive(true));
  app.post("/internal/data-access/heartbeat", receive(false));

  app.post<{ Params: { serviceId: string } }>(
    "/admin/data-access/services/:serviceId/credential",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      await requireServiceAdmin(request, auth, true);
      const credential = await registry.issueCredential(request.params.serviceId);
      return reply
        .header("cache-control", "no-store")
        .send({ service_id: request.params.serviceId, credential });
    },
  );

  for (const operation of Object.keys(managementOperations) as Array<
    keyof typeof managementOperations
  >) {
    app.route<{ Params: { serviceId: string } }>({
      method: managementOperations[operation].method,
      url: `/admin/data-access/services/:serviceId/${operation}`,
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        await requireServiceAdmin(request, auth);
        const service = (await registry.listHealthyServices()).find(
          (item) => item.serviceId === request.params.serviceId,
        );
        if (!service)
          throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "DAS 实例尚未注册或不可用");
        return reply.send(
          await managementClient.execute(
            service.serviceId,
            service.serviceUrl,
            operation,
            request.body,
          ),
        );
      },
    });
  }

  /** 返回 API 当前登记的健康 DAS 实例，供管理端诊断。 */
  app.get("/internal/data-access/services", async (request, reply) => {
    reply.header("cache-control", "no-store");
    await requireServiceAdmin(request, auth);
    const services = await registry.listHealthyServices();
    return reply.send({
      items: services.map((service) => ({
        service_id: service.serviceId,
        service_url: service.serviceUrl,
        service_version: service.serviceVersion,
        status: service.status,
        last_heartbeat_at: dayjs(service.lastHeartbeatAt)
          .utcOffset(8)
          .format("YYYY-MM-DD HH:mm:ss"),
        sources: service.sources,
      })),
    });
  });

  /** 按健康 DAS 实例读取指定 source_id 的物理目录。 */
  app.get<{ Params: { sourceId: string } }>(
    "/internal/data-access/catalog/:sourceId",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      await requireServiceAdmin(request, auth);
      const services = await registry.listHealthyServices();
      const service = services.find((item) =>
        item.sources.some(
          (source) => source.source_id === request.params.sourceId && source.status === "healthy",
        ),
      );
      if (!service) throw new ApplicationError("DATA_SOURCE_UNAVAILABLE", "没有可用的 DAS 数据源");
      return reply.send({
        source_id: request.params.sourceId,
        service_id: service.serviceId,
        items: await catalogClient.listCatalog(
          service.serviceUrl,
          request.params.sourceId,
          service.serviceId,
        ),
      });
    },
  );
}

export { deriveDataAccessServiceUrl, registerDataAccessRoutes };
