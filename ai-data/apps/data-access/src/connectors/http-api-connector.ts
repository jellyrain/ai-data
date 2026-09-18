import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

import axios, { type AxiosInstance } from "axios";
import dayjs from "dayjs";
import { JSONPath } from "jsonpath-plus";
import {
  datasetColumnSchema,
  MAX_QUERY_RESPONSE_BYTES,
  type QueryParameter,
} from "@ai-data/contracts";

import type { DataSourceConfig } from "../data-sources/data-source-types";
import type { ApiDatasetMapping } from "./api-dataset-mapping-types";
import type { DataSourceConnector } from "./connector";
import type { DiscoveredDataset } from "./connector-catalog";
import { connectorExecutionResultSchema, type ConnectorExecutionResult } from "./connector-result";
import type { ExecutableQuery } from "./executable-query";
import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import { normalizeResultValue } from "./result-value";
import { apiRequestParameterMappingSchema } from "./api-request-parameter-mapping";
import { resolveParameters } from "./parameter-validator";
import type { ActiveQueryOptions, ConnectorExecutionOptions } from "./query-execution-types";
import { QueryResourceGate } from "./query-resource-gate";
import { QueryResourceError } from "./query-resource-error";
import { assertFixedOutput } from "./fixed-output-validator";
import { assertResultBudget } from "./result-budget";

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

/** 按管理员配置的请求路径和 JSONPath 映射执行 HTTP API 虚拟表。 */
class HttpApiConnector implements DataSourceConnector {
  readonly kind = "http_api" as const;
  private readonly client: AxiosInstance;
  private readonly resources: QueryResourceGate;
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
    // socket 容量与在途请求数分别受连接池上限、并发上限约束。
    this.resources = new QueryResourceGate(config);
    this.client = axios.create({
      baseURL: secret.baseUrl,
      timeout: config.timeoutMs,
      maxContentLength: MAX_QUERY_RESPONSE_BYTES,
      headers: secret.headers,
      httpAgent: this.agent,
      httpsAgent: this.secureAgent,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  readonly sourceId: string;

  /** 对根路径发送 HEAD；低于 500 的响应视为服务可达，复用当前 HTTP 连接代理。 */
  async checkHealth() {
    try {
      await this.resources.run((options) =>
        executeHttpRequest(() =>
          this.client.head("/", {
            signal: options.signal,
            timeout: options.timeoutMs,
            validateStatus: (status) => status < 500,
          }),
        ),
      );
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
    return mappings.map((mapping) => {
      assertApiMapping(mapping, this.sourceId);
      return {
        kind: "api_dataset" as const,
        native_object_name: mapping.objectId,
        columns: mapping.response.fields.map((field) => ({
          name: field.name,
          data_type: field.dataType,
          nullable: field.nullable,
          ...(field.sourceDescription ? { source_description: field.sourceDescription } : {}),
        })),
        has_complete_output: true,
        query_parameters: apiParameterDefinitions(mapping),
      };
    });
  }

  /** 按虚拟表固定请求定义调用 HTTP API，并映射为统一表格结果。 */
  execute(
    query: ExecutableQuery,
    options: ConnectorExecutionOptions = {},
  ): Promise<ConnectorExecutionResult> {
    return this.resources.run((active) => this.executeQuery(query, active), {
      ...options,
      timeoutMs: query.timeout_ms,
    });
  }

  private async executeQuery(
    query: ExecutableQuery,
    options: ActiveQueryOptions,
  ): Promise<ConnectorExecutionResult> {
    const deadline = dayjs().add(options.timeoutMs, "millisecond").valueOf();
    if (query.type !== "parameterized_query") {
      throw new Error("HTTP API 连接器只支持参数化查询");
    }
    if (query.source_id !== this.sourceId) throw new Error("查询数据源与 HTTP 连接器不匹配");
    const mapping = await this.mappingLookup.findBySourceIdAndObjectId(
      this.sourceId,
      query.from.object_id,
    );
    if (mapping === undefined) {
      throw new Error(`HTTP API 虚拟表不存在: ${query.from.native_object_name}`);
    }

    assertApiMapping(mapping, this.sourceId);
    assertFixedOutput(
      query.fixed_output,
      mapping.response.fields.map((field) => ({
        name: field.name,
        data_type: field.dataType,
        nullable: field.nullable,
      })),
    );
    if (mapping.objectId !== query.from.object_id) throw new Error("HTTP 虚拟表映射与查询不匹配");
    // 输入按管理员定义校验并补齐默认值，所有拒绝在外部调用前完成。
    const parameters = resolveParameters(apiParameterDefinitions(mapping), query.parameters);
    const values = new Map(parameters.map((parameter) => [parameter.name, parameter.value]));
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

    options.signal.throwIfAborted();
    const response = await executeHttpRequest(() =>
      this.client.request({
        signal: options.signal,
        timeout: Math.max(1, dayjs(deadline).diff(dayjs())),
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
    // JSONPath 返回匹配项列表；object 模式只取首项，list 模式逐项转换。
    const sourceRows = mapping.response.mode === "list" ? selected : selected.slice(0, 1);
    const limitedRows = sourceRows
      .slice(0, query.row_limit)
      .map((item) => mapApiRow(item, mapping));
    const columns = mapping.response.fields.map((field) => ({
      name: field.name,
      data_type: field.dataType,
    }));
    assertResultBudget({ columns, rows: limitedRows });
    return connectorExecutionResultSchema.parse({
      columns: mapping.response.fields.map((field) => ({
        name: field.name,
        data_type: field.dataType,
      })),
      rows: limitedRows,
      row_count: limitedRows.length,
      truncated: sourceRows.length > limitedRows.length,
    });
  }

  /** 关闭 HTTP Keep-Alive 连接代理和并发闸门。 */
  async close(): Promise<void> {
    const closing = this.resources.close();
    this.agent.destroy();
    this.secureAgent.destroy();
    await closing;
  }
}

/** Axios 中断实际请求后，等待已销毁 socket 关闭，再让执行名额被后续工作使用。 */
async function executeHttpRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === "ERR_BAD_RESPONSE" && error.message.includes("maxContentLength"))
        throw new QueryResourceError("QUERY_LIMIT_EXCEEDED", { cause: error });
      const socket = (error.request as { socket?: Socket } | undefined)?.socket;
      if (socket?.destroyed && !socket.closed) {
        await new Promise<void>((resolve) => socket.once("close", resolve));
      }
      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        throw new QueryResourceError("QUERY_TIMEOUT", { cause: error });
      }
    }
    throw error;
  }
}

/** 从同一映射构造目录与执行使用的可信参数定义。 */
function apiParameterDefinitions(mapping: ApiDatasetMapping): QueryParameter[] {
  return mapping.request.parameterMappings.map((parameter) => ({
    name: parameter.name,
    allowed_ops: ["eq"],
    data_type: parameter.dataType,
    required: parameter.required,
    ...(parameter.defaultValue === undefined ? {} : { default_value: parameter.defaultValue }),
  }));
}

/** 虚拟表必须拥有唯一且完整的输入输出定义，HTTP 请求位置也不能互相覆盖。 */
function assertApiMapping(mapping: ApiDatasetMapping, sourceId: string): void {
  if (mapping.sourceId !== sourceId) throw new Error("HTTP 虚拟表数据源不匹配");
  const parameters = mapping.request.parameterMappings.map((parameter) =>
    apiRequestParameterMappingSchema.parse(parameter),
  );
  if (
    new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length ||
    new Set(
      parameters.map(
        (parameter) =>
          `${parameter.location}:${parameter.location === "header" ? parameter.key.toLowerCase() : parameter.key}`,
      ),
    ).size !== parameters.length
  ) {
    throw new Error("HTTP 参数定义或请求位置不能重复");
  }
  if (
    mapping.request.method === "GET" &&
    parameters.some((parameter) => parameter.location === "body")
  ) {
    throw new Error("GET 请求参数不能映射至 body");
  }
  const columns = mapping.response.fields.map((field) =>
    datasetColumnSchema.parse({
      name: field.name,
      data_type: field.dataType,
      nullable: field.nullable,
    }),
  );
  if (
    columns.length === 0 ||
    new Set(columns.map((column) => column.name)).size !== columns.length
  ) {
    throw new Error("HTTP 固定输出必须包含非空且唯一的列定义");
  }
}

/** 每列取首个匹配值，执行字段可空约束并转换为声明的 JSON 类型。 */
function mapApiRow(item: unknown, mapping: ApiDatasetMapping): Record<string, unknown> {
  return Object.fromEntries(
    mapping.response.fields.map((field) => {
      const values = JSONPath({
        path: field.jsonPath,
        json: item as object,
      }) as unknown as unknown[];
      const value = values[0];
      if ((value === undefined || value === null) && !field.nullable) {
        throw new Error(`HTTP API 字段映射缺少必填值: ${field.name}`);
      }
      return [field.name, normalizeResultValue(value ?? null, field.dataType, field.name)];
    }),
  );
}

export { HttpApiConnector };
export type { ApiDatasetMappingLookup };
