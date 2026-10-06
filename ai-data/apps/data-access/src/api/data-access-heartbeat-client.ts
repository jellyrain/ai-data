import axios, { type AxiosInstance } from "axios";
import {
  dataAccessHeartbeatAckSchema,
  dataAccessSessionSchema,
  dataAccessCredentialResponseSchema,
  type DataAccessHeartbeat,
} from "@ai-data/contracts";
import type { DasConfig } from "../config/das-config";

/** 启动注册并维护心跳会话；同一进程的上报串行进行。 */
class DataAccessHeartbeatClient {
  private sessionToken: string | undefined;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly config: DasConfig["api"],
    private readonly loadCredential: () => string,
    private readonly http: Pick<AxiosInstance, "post"> = axios.create({
      baseURL: config.base_url,
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    }),
  ) {}

  /** 会话失效时按配置重新取得接入凭据并注册，当前健康快照随注册一并更新。 */
  async send(heartbeat: DataAccessHeartbeat): Promise<void> {
    if (this.pending) return this.pending;
    const operation = this.sendOnce(heartbeat).finally(() => {
      this.pending = undefined;
    });
    this.pending = operation;
    return operation;
  }

  private async sendOnce(heartbeat: DataAccessHeartbeat): Promise<void> {
    if (!this.sessionToken) return this.register(heartbeat);
    const response = await this.post(this.config.heartbeat_path, heartbeat, this.sessionToken);
    if (response.status === 401) {
      this.sessionToken = undefined;
      return this.register(heartbeat);
    }
    if (response.status !== 200) throw new Error(`DAS 心跳被 API 拒绝: HTTP ${response.status}`);
    const ack = dataAccessHeartbeatAckSchema.safeParse(response.data);
    if (!ack.success || ack.data.service_id !== heartbeat.service_id)
      throw new Error("DAS 心跳确认格式无效");
  }

  private async register(heartbeat: DataAccessHeartbeat): Promise<void> {
    // 自动模式每次注册领取当前版本，JWT 只在本次调用中保存；文件模式继续按需重读。
    const credential = this.config.registration_secret
      ? await this.acquireCredential(heartbeat.service_id, this.config.registration_secret)
      : this.loadCredential();
    const response = await this.post(
      this.config.registration_path ?? "/internal/data-access/register",
      heartbeat,
      credential,
    );
    if (response.status !== 200) throw new Error(`DAS 注册被 API 拒绝: HTTP ${response.status}`);
    const session = dataAccessSessionSchema.safeParse(response.data);
    if (!session.success || session.data.service_id !== heartbeat.service_id)
      throw new Error("DAS 注册响应格式无效");
    this.sessionToken = session.data.session_token;
  }

  /** 先检查响应合同与实例绑定，再将领取结果用于注册。 */
  private async acquireCredential(serviceId: string, secret: string): Promise<string> {
    const response = await this.post(
      "/internal/data-access/credential",
      { service_id: serviceId },
      secret,
    );
    if (response.status !== 200) {
      const hint = response.status === 401 ? "，请检查实例接入密钥及 API 中的启用配置" : "";
      throw new Error(`DAS 领取接入凭据失败: HTTP ${response.status}${hint}`);
    }
    const parsed = dataAccessCredentialResponseSchema.safeParse(response.data);
    if (!parsed.success || parsed.data.service_id !== serviceId)
      throw new Error("DAS 接入凭据响应格式或实例标识无效");
    return parsed.data.credential;
  }

  /** 网络异常可能附带含凭据的请求配置，对外只给出固定连接提示。 */
  private async post(path: string, body: unknown, token: string) {
    try {
      return await this.http.post(path, body, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new Error("DAS 无法连接 API，请检查 API 地址、网络及服务状态");
    }
  }
}

export { DataAccessHeartbeatClient };
