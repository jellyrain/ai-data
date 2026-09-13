import axios, { type AxiosInstance } from "axios";
import {
  dataAccessHeartbeatAckSchema,
  dataAccessSessionSchema,
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

  /** 会话失效时重新读取接入文件并注册，当前健康快照随注册一并更新。 */
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
    const response = await this.http.post(this.config.heartbeat_path, heartbeat, {
      headers: { authorization: `Bearer ${this.sessionToken}` },
    });
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
    const response = await this.http.post(
      this.config.registration_path ?? "/internal/data-access/register",
      heartbeat,
      {
        headers: { authorization: `Bearer ${this.loadCredential()}` },
      },
    );
    if (response.status !== 200) throw new Error(`DAS 注册被 API 拒绝: HTTP ${response.status}`);
    const session = dataAccessSessionSchema.safeParse(response.data);
    if (!session.success || session.data.service_id !== heartbeat.service_id)
      throw new Error("DAS 注册响应格式无效");
    this.sessionToken = session.data.session_token;
  }
}

export { DataAccessHeartbeatClient };
