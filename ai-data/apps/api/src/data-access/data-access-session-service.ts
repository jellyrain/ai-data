import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import dayjs from "dayjs";
import type { DataAccessHeartbeat, DataAccessSession } from "@ai-data/contracts";
import type { ApiConfig } from "../config/api-config";
import type { JwtService } from "../auth/jwt-service";
import { ApplicationError } from "../errors/application-error";
import type { DataAccessServiceRegistry } from "./data-access-types";

/** 已校验的注册身份与运行期心跳会话绑定。 */
type ServiceSession = {
  /** 仅保留随机会话凭据的 SHA-256 摘要。 */
  tokenHash: Buffer;
  /** 注册连接来源、上报端口与协议组成的实例地址。 */
  serviceUrl: string;
  /** 创建会话时批准的接入凭证版本。 */
  credentialVersion: number;
  /** 空闲失效时间，Unix 毫秒；成功心跳后续期。 */
  expiresAt: number;
};

/** 认证注册与心跳会话管理；API 重启后要求 DAS 重新注册。 */
class DataAccessSessionService {
  private readonly sessions = new Map<string, ServiceSession>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: DataAccessServiceRegistry,
    private readonly jwt: Pick<
      JwtService,
      "verifyRegistrationCredential" | "signRegistrationCredential"
    >,
    private readonly trustedServices: NonNullable<ApiConfig["trusted_data_access_services"]>,
    private readonly idleTimeoutMs = 90_000,
  ) {}

  /** 管理员领取已批准实例当前版本的接入凭证。 */
  async issueCredential(serviceId: string): Promise<string> {
    return this.jwt.signRegistrationCredential(
      serviceId,
      this.trustedService(serviceId).credential_version,
    );
  }

  /** 注册是新增实例、切换地址和替换旧会话的唯一入口。 */
  async register(
    heartbeat: DataAccessHeartbeat,
    serviceUrl: string,
    credential: string,
  ): Promise<DataAccessSession> {
    const trusted = this.trustedService(heartbeat.service_id);
    const version = await this.jwt.verifyRegistrationCredential(credential, heartbeat.service_id);
    if (version !== trusted.credential_version) this.reject();
    return this.serialize(heartbeat.service_id, async () => {
      // 验签和等待期间的禁用或轮换同样生效。
      if (version !== this.trustedService(heartbeat.service_id).credential_version) this.reject();
      const token = randomBytes(32).toString("base64url");
      await this.registry.registerHeartbeat(heartbeat, serviceUrl);
      this.sessions.set(heartbeat.service_id, {
        tokenHash: this.digest(token),
        serviceUrl,
        credentialVersion: version,
        expiresAt: dayjs().add(this.idleTimeoutMs, "millisecond").valueOf(),
      });
      return {
        service_id: heartbeat.service_id,
        session_token: token,
        session_timeout_seconds: this.idleTimeoutMs / 1000,
      };
    });
  }

  /** 心跳通过随机会话凭据定位既有注册，仅更新绑定地址上的健康状态。 */
  async heartbeat(
    heartbeat: DataAccessHeartbeat,
    serviceUrl: string,
    token: string,
  ): Promise<void> {
    this.trustedService(heartbeat.service_id);
    await this.serialize(heartbeat.service_id, async () => {
      const session = this.activeSession(heartbeat.service_id);
      if (
        !session ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !timingSafeEqual(session.tokenHash, this.digest(token)) ||
        session.serviceUrl !== serviceUrl
      )
        this.reject();
      await this.registry.registerHeartbeat(heartbeat, session.serviceUrl);
      session.expiresAt = dayjs().add(this.idleTimeoutMs, "millisecond").valueOf();
    });
  }

  /** 事务可提供自己的健康读取器；调度仍由本实例的有效注册会话约束。 */
  async listRegisteredServices() {
    const services = await this.registry.listRegisteredServices();
    return services.map(({ isExpired, ...service }) => ({
      ...service,
      connectionStatus:
        isExpired || this.activeSession(service.serviceId)?.serviceUrl !== service.serviceUrl
          ? ("offline" as const)
          : service.status === "unhealthy"
            ? ("unhealthy" as const)
            : ("online" as const),
    }));
  }

  /** 事务可提供自己的健康读取器；调度仍由本实例的有效注册会话约束。 */
  async listHealthyServices(
    registry: Pick<DataAccessServiceRegistry, "listHealthyServices"> = this.registry,
  ) {
    const services = await registry.listHealthyServices();
    return services.filter(
      (service) => this.activeSession(service.serviceId)?.serviceUrl === service.serviceUrl,
    );
  }

  private trustedService(serviceId: string) {
    const trusted = this.trustedServices.find(
      (service) => service.service_id === serviceId && service.enabled,
    );
    if (!trusted) this.reject();
    return trusted;
  }

  private activeSession(serviceId: string): ServiceSession | undefined {
    const session = this.sessions.get(serviceId);
    const trusted = this.trustedServices.find(
      (service) => service.service_id === serviceId && service.enabled,
    );
    if (
      !session ||
      !trusted ||
      session.credentialVersion !== trusted.credential_version ||
      !dayjs(session.expiresAt).isAfter(dayjs())
    ) {
      this.sessions.delete(serviceId);
      return undefined;
    }
    return session;
  }

  private digest(token: string): Buffer {
    return createHash("sha256").update(token).digest();
  }

  private reject(): never {
    throw new ApplicationError("AUTHENTICATION_FAILED", "DAS 身份或会话无效，请重新注册");
  }

  /** 按已批准实例串行提交，避免旧心跳覆盖重新注册后的地址。 */
  private async serialize<T>(serviceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(serviceId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.pending.set(serviceId, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(serviceId) === current) this.pending.delete(serviceId);
    }
  }
}

export { DataAccessSessionService };
