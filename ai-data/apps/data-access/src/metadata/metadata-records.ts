import { dataTypeSchema, queryCapabilitiesSchema } from "@ai-data/contracts";
import { z } from "zod";

/** DAS 运行时可选择的连接器类型；枚举值必须与连接器工厂支持的类型一致。 */
const connectorKindSchema = z.enum(["sqlserver", "mysql", "postgresql", "oracle", "http_api"]);
/** 本地密钥库文件名可安全使用的密钥版本标识。 */
const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "key_id 必须是安全密钥标识");

/** 对外对象和 HTTP API 虚拟表中使用的安全标识符。 */
const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

/** 元数据库中一条数据源配置的读取记录。 */
const dataSourceConfigRowSchema = z
  .object({
    /** DAS 内部唯一的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 决定 DataSourceManager 创建哪一种业务连接器。 */
    connector_kind: connectorKindSchema,
    /** 指向加密业务连接配置的引用，不保存明文凭据。 */
    secret_ref: z.string().min(1),
    /** SQL Server、MySQL 或 PostgreSQL 数据源绑定的业务数据库名称。 */
    target_database: z.string().min(1).nullable(),
    /** Oracle 连接目标的标识方式。 */
    oracle_connect_type: z.enum(["sid", "service_name"]).nullable(),
    /** Oracle SID 或 Service Name。 */
    oracle_connect_target: z.string().min(1).nullable(),
    /** 管理员停用数据源时不允许它被创建为运行时连接器。 */
    is_enabled: z.boolean(),
    /** 单次业务数据源执行的最终超时上限，单位毫秒。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 当前 source_id 的业务数据库连接池最大连接数。 */
    connection_pool_limit: z.number().int().min(1).max(100),
    /** 当前 source_id 同时执行的业务请求上限。 */
    concurrency_limit: z.number().int().min(1).max(1000),
    /** DAS 向调用方返回的最大行数。 */
    row_limit: z.number().int().min(1).max(5000),
    /** 查询规划器使用的业务成本预算。 */
    cost_limit: z.number().int().positive(),
  })
  /** 持久化记录只接受当前运行时支持的配置列。 */
  .strict()
  .superRefine((value, context) => {
    if (["sqlserver", "mysql", "postgresql"].includes(value.connector_kind)) {
      if (value.target_database === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_database"],
          message: "数据库连接器必须配置 target_database",
        });
      }
      if (value.oracle_connect_type !== null || value.oracle_connect_target !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "数据库连接器不能配置 Oracle 连接目标",
        });
      }
    }

    if (value.connector_kind === "oracle") {
      if (value.oracle_connect_type === null || value.oracle_connect_target === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Oracle 连接器必须配置 oracle_connect_type 和 oracle_connect_target",
        });
      }
      if (value.target_database !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_database"],
          message: "Oracle 连接器不能配置 target_database",
        });
      }
    }

    if (value.connector_kind === "http_api") {
      if (
        value.target_database !== null ||
        value.oracle_connect_type !== null ||
        value.oracle_connect_target !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "HTTP API 连接器不能配置数据库目标",
        });
      }
    }
  });

/** 运行时可使用的一条数据源配置。 */
type DataSourceConfig = {
  /** 数据源配置标识。 */
  sourceId: string;
  /** 连接器工厂选择依据。 */
  connectorKind: z.infer<typeof connectorKindSchema>;
  /** 加密连接配置引用。 */
  secretRef: string;
  /** SQL Server、MySQL 或 PostgreSQL 的目标数据库；每个 source_id 独立绑定。 */
  targetDatabase?: string;
  /** Oracle 连接目标的标识方式。 */
  oracleConnectType?: "sid" | "service_name";
  /** Oracle SID 或 Service Name；每个 source_id 独立绑定。 */
  oracleConnectTarget?: string;
  /** 执行超时上限，单位毫秒。 */
  timeoutMs: number;
  /** 业务数据库连接池最大连接数。 */
  connectionPoolLimit: number;
  /** 单数据源业务请求并发上限。 */
  concurrencyLimit: number;
  /** 最终返回行数上限。 */
  rowLimit: number;
  /** 查询成本预算。 */
  costLimit: number;
};

/** 元数据库中一条 AES-256-GCM 数据源密文记录。 */
const dataSourceSecretRowSchema = z
  .object({
    /** 数据源配置引用的密文标识。 */
    secret_ref: z.string().min(1),
    /** 当前阶段只允许 AES-256-GCM 密文。 */
    encryption_algorithm: z.literal("AES-256-GCM"),
    /** 解密此密文所需的本地主密钥版本。 */
    key_id: keyIdSchema,
    /** SQL Server VARBINARY 读取出的 AES-GCM 密文。 */
    encrypted_payload: z.instanceof(Buffer),
    /** IV 与认证标签的 JSON 持久化内容。 */
    encryption_metadata_json: z.string(),
  })
  /** 密文记录不接受非加密相关列进入解密边界。 */
  .strict();

/** AES-GCM 密文附带的随机 IV 与认证标签。 */
const aesGcmEncryptionMetadataSchema = z
  .object({
    /** 每条密文独立生成的 12 字节随机 IV，使用十六进制文本保存。 */
    iv_hex: z.string().regex(/^[0-9a-f]{24}$/i, "iv_hex 必须是 12 字节十六进制文本"),
    /** GCM 解密前必须验证的 16 字节认证标签，使用十六进制文本保存。 */
    auth_tag_hex: z.string().regex(/^[0-9a-f]{32}$/i, "auth_tag_hex 必须是 16 字节十六进制文本"),
  })
  .strict();

/** 解密器可直接消费的一条加密数据源凭据。 */
type EncryptedDataSourceSecret = {
  secretRef: string;
  keyId: string;
  encryptedPayload: Buffer;
  metadata: z.infer<typeof aesGcmEncryptionMetadataSchema>;
};

/** 元数据库中一条本地对象白名单记录。 */
const exposedObjectRowSchema = z
  .object({
    /** 所属数据源配置标识。 */
    source_id: z.string().min(1),
    /** API 可引用的逻辑对象标识。 */
    object_id: identifierSchema,
    /** 对象真实类型决定连接器发现和执行方式。 */
    object_kind: z.enum(["table", "view", "stored_procedure", "api_dataset"]),
    /** 数据库中真实 Schema；HTTP API 虚拟表允许没有该值。 */
    native_schema_name: z.string().min(1).nullable(),
    /** 数据库或虚拟表的真实对象名；未映射对象不能交给连接器。 */
    native_object_name: z.string().min(1).nullable(),
    /** 是否允许将对象纳入 API 可发现目录。 */
    is_discoverable: z.boolean(),
    /** 是否允许查询规划器把对象映射为最终 DSL。 */
    is_queryable: z.boolean(),
    /** 基础查询能力的 JSON 持久化内容。 */
    capabilities_json: z.string(),
  })
  /** 防止人工扩展列被未经审查地带入对象白名单。 */
  .strict();

/** DAS 本地允许暴露给 API 的数据对象。 */
type ExposedSourceObject = {
  /** 所属数据源配置标识。 */
  sourceId: string;
  /** API 与审计使用的逻辑对象标识。 */
  objectId: string;
  /** 对象真实类型。 */
  objectKind: "table" | "view" | "stored_procedure" | "api_dataset";
  /** 数据库物理 Schema。 */
  nativeSchemaName?: string;
  /** 数据库物理对象或虚拟表名。 */
  nativeObjectName?: string;
  /** 是否可以出现在目录发现结果中。 */
  isDiscoverable: boolean;
  /** 是否可以用于最终查询规划。 */
  isQueryable: boolean;
  /** 管理员配置并经过 Schema 校验的基础能力。 */
  queryCapabilities: z.infer<typeof queryCapabilitiesSchema>;
};

/** HTTP API 虚拟表请求参数的固定映射位置。 */
const apiRequestParameterMappingSchema = z
  .object({
    /** 目录中已经审核的参数名称。 */
    name: identifierSchema,
    /** 参数只能进入管理员配置的请求位置。 */
    location: z.enum(["query", "header", "body"]),
    /** 外部 API 请求中使用的固定参数键。 */
    key: z.string().min(1),
  })
  /** 请求参数映射不得接受未配置的外部字段。 */
  .strict();

/** HTTP API 响应中一个字段到统一表列的映射。 */
const apiDatasetFieldMappingSchema = z
  .object({
    /** 返回给 API 的统一列名。 */
    name: identifierSchema,
    /** 只由管理员配置并在连接器内部使用的 JSONPath。 */
    json_path: z.string().regex(/^\$/, "json_path 必须以 $ 开头"),
    /** 映射后输出的统一数据类型。 */
    data_type: dataTypeSchema,
    /** 原始 JSON 字段缺失或空值时是否允许输出 null。 */
    nullable: z.boolean(),
    /** 管理员可选配置的接口字段说明。 */
    source_description: z.string().optional(),
  })
  /** 字段映射不得携带调用方可控的额外执行配置。 */
  .strict();

/** 元数据库中 HTTP API 虚拟表定义的读取记录。 */
const apiDatasetMappingRowSchema = z
  .object({
    /** 所属 HTTP API 数据源配置标识。 */
    source_id: z.string().min(1),
    /** 管理员配置并暴露给 API 的虚拟表标识。 */
    object_id: identifierSchema,
    /** 连接器允许调用的固定 HTTP 方法。 */
    request_method: z.enum(["GET", "POST"]),
    /** 相对于 secret_ref 中 base URL 的固定路径。 */
    request_path: z.string().regex(/^\//, "request_path 必须以 / 开头"),
    /** 输入参数映射的 JSON 持久化内容。 */
    request_parameter_mappings_json: z.string(),
    /** 结果路径指向多行数组还是单个对象，由管理员显式配置而非运行时猜测。 */
    response_mode: z.enum(["list", "object"]),
    /** 从原始响应定位数组或单个对象的管理员配置 JSONPath。 */
    response_path: z.string().regex(/^\$/, "response_path 必须以 $ 开头"),
    /** 响应字段映射的 JSON 持久化内容。 */
    field_mappings_json: z.string(),
  })
  /** 虚拟表记录只接受已审核请求和响应配置。 */
  .strict();

/** HTTP API 连接器可执行的一张管理员配置虚拟表。 */
type ApiDatasetMapping = {
  /** 所属 HTTP API 数据源配置标识。 */
  sourceId: string;
  /** API 可查询的虚拟表标识。 */
  objectId: string;
  /** 连接器固定执行的 HTTP 请求定义。 */
  request: {
    /** 已审核的请求方法。 */
    method: "GET" | "POST";
    /** 相对于数据源 base URL 的固定路径。 */
    path: string;
    /** 目录参数到固定请求位置的映射。 */
    parameterMappings: Array<z.infer<typeof apiRequestParameterMappingSchema>>;
  };
  /** 原始响应到统一扁平表的受信任映射。 */
  response: {
    /** list 表示逐项映射；object 表示映射一次后包装为一行。 */
    mode: "list" | "object";
    /** 定位数组或对象的 JSONPath。 */
    path: string;
    /** 每列的提取与标准化类型配置。 */
    fields: Array<{
      /** 输出给 API 的统一列名。 */
      name: string;
      /** 仅在 HTTP API 连接器内部使用的 JSONPath。 */
      jsonPath: string;
      /** 提取后转换的统一数据类型。 */
      dataType: z.infer<typeof dataTypeSchema>;
      /** 原始字段缺失时是否可以输出空值。 */
      nullable: boolean;
      /** 可选的外部接口字段说明。 */
      sourceDescription?: string;
    }>;
  };
};

/** DAS 必须记录的查询执行、拒绝、超时或失败事件。 */
const queryAuditEntrySchema = z
  .object({
    /** API 与 DAS 全链路使用的请求关联标识。 */
    correlationId: z.string().min(1),
    /** API 创建的分析运行标识；基础拒绝可能发生在尚未解析该字段之前。 */
    analysisRunId: z.string().min(1).optional(),
    /** 本次访问的 API 用户标识；JWT 失败时可能不可用。 */
    userId: z.string().min(1).optional(),
    /** 本次访问的组织标识；JWT 失败时可能不可用。 */
    organizationId: z.string().min(1).optional(),
    /** API 签发的最终策略版本；无有效访问上下文时允许缺失。 */
    policyVersion: z.number().int().positive().optional(),
    /** 实际选择或尝试选择的数据源；早期拒绝时允许缺失。 */
    sourceId: z.string().min(1).optional(),
    /** 本次查询涉及的逻辑对象，默认空数组用于早期拒绝。 */
    objectIds: z.array(identifierSchema).default([]),
    /** 不含自由 SQL 的查询 DSL 摘要，默认空对象用于早期拒绝。 */
    querySummary: z.record(z.string(), z.unknown()).default({}),
    /** 不含敏感明文的参数摘要，默认空对象用于早期拒绝。 */
    parametersSummary: z.record(z.string(), z.unknown()).default({}),
    /** 本次最终查询是否合并了 API 签发的行过滤。 */
    rowFilterInjected: z.boolean().default(false),
    /** DAS 请求的最终处理结果，用于审计、失败率和告警。 */
    outcome: z.enum(["executed", "rejected", "timed_out", "failed"]),
    /** 实际返回行数，仅成功执行后可用。 */
    rowCount: z.number().int().nonnegative().optional(),
    /** 从接收请求至完成处理的耗时，单位毫秒。 */
    durationMs: z.number().int().nonnegative().optional(),
    /** 拒绝路径的可审计原因；成功执行时无需填写。 */
    rejectionReason: z.string().min(1).optional(),
    /** 可供 API 归类的稳定错误码；成功执行时无需填写。 */
    errorCode: z.string().min(1).optional(),
  })
  /** 审计入口拒绝未知字段，避免写入未经设计的敏感内容。 */
  .strict();

/** 审计写入前通过应用边界校验的事件类型。 */
type QueryAuditEntry = z.infer<typeof queryAuditEntrySchema>;

/** 解析 JSON 配置列，并用对应 Schema 拒绝损坏或人工误改的记录。 */
function parsePersistedJson<T>(json: string, schema: z.ZodType<T>, fieldName: string): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${fieldName} 不是合法 JSON: ${message}`, { cause: error });
  }

  return schema.parse(parsed);
}

export {
  apiDatasetFieldMappingSchema,
  apiDatasetMappingRowSchema,
  apiRequestParameterMappingSchema,
  aesGcmEncryptionMetadataSchema,
  connectorKindSchema,
  dataSourceSecretRowSchema,
  dataSourceConfigRowSchema,
  exposedObjectRowSchema,
  parsePersistedJson,
  queryAuditEntrySchema,
};

export type {
  ApiDatasetMapping,
  DataSourceConfig,
  EncryptedDataSourceSecret,
  ExposedSourceObject,
  QueryAuditEntry,
};
