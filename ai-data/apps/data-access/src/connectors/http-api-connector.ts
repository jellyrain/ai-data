import http from "node:http";
import https from "node:https";

import axios, { type AxiosInstance } from "axios";
import dayjs from "dayjs";
import pLimit from "p-limit";
import { JSONPath } from "jsonpath-plus";

import type { DataSourceConfig } from "../metadata/metadata-records";
import type { ApiDatasetMapping } from "../metadata/metadata-records";
import type { DataSourceConnector } from "./connector";
import type { DiscoveredDataset } from "./connector-catalog";
import { connectorExecutionResultSchema, type ConnectorExecutionResult } from "./connector-result";
import type { ExecutableQuery } from "./executable-query";
import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";

/** HTTP 虚拟表定义的最小读取能力。 */
interface ApiDatasetMappingLookup {
  /** 读取管理员配置的固定请求和响应映射。 */
  findBySourceIdAndObjectId(
    sourceId: string,
    objectId: string,
  ): Promise<ApiDatasetMapping | undefined>;
  /** 列出一个 HTTP 数据源的全部虚拟表定义。 */
  listBySourceId(sourceId: string): Promise<ApiDatasetMapping[]>;
}

/** 使用 Axios 和受控 JSONPath 映射执行 HTTP API 虚拟表。 */
class HttpApiConnector implements DataSourceConnector {
  readonly kind = "http_api" as const;
  private readonly client: AxiosInstance;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly agent: http.Agent;
  private readonly secureAgent: https.Agent;

  constructor(
    private readonly config: DataSourceConfig,
    private readonly secret: Extract<ResolvedDataSourceSecret, { connectorKind: "http_api" }>,
    private readonly mappingLookup: ApiDatasetMappingLookup,
  ) {
    this.sourceId = config.sourceId;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: config.connectionPoolLimit });
    this.secureAgent = new https.Agent({ keepAlive: true, maxSockets: config.connectionPoolLimit });
    this.limit = pLimit(config.concurrencyLimit);
    this.client = axios.create({
      baseURL: secret.baseUrl,
      timeout: config.timeoutMs,
      headers: secret.headers,
      httpAgent: this.agent,
      httpsAgent: this.secureAgent,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  readonly sourceId: string;

  /** 对 HTTP API 发起轻量请求，使用同一受控连接池。 */
  async checkHealth() {
    try {
      await this.client.head("/", { validateStatus: (status) => status < 500 });
      return {
        source_id: this.sourceId,
        status: "healthy" as const,
        checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      };
    } catch (error) {
      return {
        source_id: this.sourceId,
        status: "unhealthy" as const,
        checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        message: error instanceof Error ? error.message : "HTTP API 健康检查失败",
      };
    }
  }

  /** HTTP API 目录完全来自管理员维护的虚拟表定义，不能自动扫描外部接口。 */
  async discoverCatalog(): Promise<DiscoveredDataset[]> {
    const mappings = await this.mappingLookup.listBySourceId(this.sourceId);
    return mappings.map((mapping) => ({
      kind: "api_dataset" as const,
      native_object_name: mapping.objectId,
      columns: mapping.response.fields.map((field) => ({
        name: field.name,
        data_type: field.dataType,
        nullable: field.nullable,
        ...(field.sourceDescription ? { source_description: field.sourceDescription } : {}),
      })),
      query_parameters: mapping.request.parameterMappings.map((parameter) => ({
        name: parameter.name,
        allowed_ops: ["eq" as const],
        data_type: "string" as const,
        required: false,
      })),
    }));
  }

  /** 按虚拟表固定请求定义调用 HTTP API，并映射为统一表格结果。 */
  async execute(query: ExecutableQuery): Promise<ConnectorExecutionResult> {
    if (query.type !== "parameterized_query") {
      throw new Error("HTTP API 连接器只支持参数化查询");
    }
    const mapping = await this.mappingLookup.findBySourceIdAndObjectId(
      this.sourceId,
      query.from.object_id,
    );
    if (mapping === undefined) {
      throw new Error(`HTTP API 虚拟表不存在: ${query.from.native_object_name}`);
    }

    const values = new Map(query.parameters.map((parameter) => [parameter.name, parameter.value]));
    const queryParams: Record<string, unknown> = {};
    const headers: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    for (const parameter of mapping.request.parameterMappings) {
      if (!values.has(parameter.name)) continue;
      const value = values.get(parameter.name);
      if (parameter.location === "query") queryParams[parameter.key] = value;
      if (parameter.location === "header") headers[parameter.key] = String(value);
      if (parameter.location === "body") body[parameter.key] = value;
    }

    const response = await this.limit(() =>
      this.client.request({
        method: mapping.request.method,
        url: mapping.request.path,
        params: queryParams,
        headers,
        ...(mapping.request.method === "POST" ? { data: body } : {}),
      }),
    );
    const selected = JSONPath({
      path: mapping.response.path,
      json: response.data as object,
    }) as unknown as unknown[];
    const sourceRows = mapping.response.mode === "list" ? selected : selected.slice(0, 1);
    const rows = sourceRows.map((item) => mapApiRow(item, mapping));
    const limitedRows = rows.slice(0, query.row_limit);
    return connectorExecutionResultSchema.parse({
      columns: mapping.response.fields.map((field) => ({
        name: field.name,
        data_type: field.dataType,
      })),
      rows: limitedRows,
      row_count: limitedRows.length,
      truncated: rows.length > limitedRows.length,
    });
  }

  /** 关闭 HTTP Keep-Alive 连接代理和并发闸门。 */
  async close(): Promise<void> {
    this.agent.destroy();
    this.secureAgent.destroy();
    this.limit.clearQueue();
  }
}

/** 将一项原始 JSON 映射为统一结果行。 */
function mapApiRow(item: unknown, mapping: ApiDatasetMapping): Record<string, unknown> {
  return Object.fromEntries(
    mapping.response.fields.map((field) => {
      const values = JSONPath({
        path: field.jsonPath,
        json: item as object,
      }) as unknown as unknown[];
      const value = values[0];
      if (value === undefined && !field.nullable) {
        throw new Error(`HTTP API 字段映射缺少必填值: ${field.name}`);
      }
      return [field.name, value ?? null];
    }),
  );
}

export { HttpApiConnector };
export type { ApiDatasetMappingLookup };
