import { z } from "zod";
import { MAX_QUERY_ROWS } from "../query/query-limits";
import { queryCapabilitiesSchema, datasetColumnSchema } from "../catalog/dataset";
import { procedureDefinitionSchema } from "./procedure-definition";
import { sqlServerTransportSchema } from "./sqlserver-transport";

/** 公开持久化配置的 SHA-256 比较基准。 */
const managementRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** 数据库连接器可保存的共享凭据类型。 */
const databaseConnectorKindSchema = z.enum(["sqlserver", "mysql", "postgresql", "oracle"]);

/** 管理端保存一套可由多个 source_id 复用的数据库服务器凭据，仅接受声明字段。 */
const sharedDatabaseCredentialsSchema = z
  .object({
    /** 多个目标库可复用的加密凭据引用。 */
    secret_ref: z.string().min(1),
    /** 此凭据对应的数据库驱动类型。 */
    connector_kind: databaseConnectorKindSchema,
    /** 数据库服务器主机名或 IP 地址。 */
    host: z.string().min(1),
    /** 数据库服务器 TCP 端口。 */
    port: z.number().int().min(1).max(65535),
    /** 部署方授予只读权限的数据库账号；本层仅接收账号名称。 */
    user: z.string().min(1),
    /** 只在加密写入和连接创建期间使用的登录密码。 */
    password: z.string().min(1),
    /** SQL Server 显式连接选项；省略时保留已有选项，首次创建使用兼容行为。 */
    sqlserver_transport: sqlServerTransportSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.connector_kind !== "sqlserver" && value.sqlserver_transport !== undefined)
      context.addIssue({
        code: "custom",
        path: ["sqlserver_transport"],
        message: "仅 SQL Server 支持此连接选项",
      });
  });

/** 管理端按共享凭据发现可绑定目标库的请求，仅接受声明字段。 */
const databaseTargetDiscoveryRequestSchema = z
  .object({
    /** 已保存的共享凭据引用。 */
    secret_ref: z.string().min(1),
    /** 用于选择目标库目录读取方式的数据库类型。 */
    connector_kind: databaseConnectorKindSchema,
    /** Oracle 发现必须先连接 CDB；其他数据库不使用该字段。 */
    oracle_connect_type: z.enum(["sid", "service_name"]).optional(),
    /** Oracle CDB 的 SID 或 Service Name。 */
    oracle_connect_target: z.string().min(1).optional(),
  })
  .strict()
  // Oracle 发现要求成对提供 CDB 连接方式和目标；其他类型省略这两个字段。
  .superRefine((value, context) => {
    const hasOracleTarget =
      value.oracle_connect_type !== undefined || value.oracle_connect_target !== undefined;
    if (
      value.connector_kind === "oracle" &&
      (value.oracle_connect_type === undefined || value.oracle_connect_target === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Oracle 目标发现必须配置 CDB 的 SID 或 Service Name",
      });
    }
    if (value.connector_kind !== "oracle" && hasOracleTarget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "非 Oracle 数据库不能配置 Oracle 连接目标",
      });
    }
  });

/** 管理端保存一个只绑定单一目标数据库或 Oracle 连接目标的数据源，仅接受声明字段。 */
const dataSourceManagementConfigSchema = z
  .object({
    /** 单一目标数据库的运行数据源标识。 */
    source_id: z
      .string()
      .min(1, "请填写数据源标识")
      .max(128, "数据源标识最多 128 个字符")
      .regex(
        /^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.-]*$/u,
        "数据源标识支持中文、英文、数字和 _ . -，须以中文、英文或下划线开头",
      ),
    /** 当前 source_id 使用的数据库连接器。 */
    connector_kind: databaseConnectorKindSchema,
    /** 指向共享服务器凭据的加密记录。 */
    secret_ref: z.string().min(1),
    /** SQL Server、MySQL 或 PostgreSQL 实际连接的目标数据库。 */
    target_database: z.string().min(1).optional(),
    /** Oracle 目标使用 SID 或 Service Name。 */
    oracle_connect_type: z.enum(["sid", "service_name"]).optional(),
    /** Oracle 目标的 SID 或 Service Name；与连接方式成对提供，其他类型省略。 */
    oracle_connect_target: z.string().min(1).optional(),
    /** 是否允许创建运行时连接器；省略时默认启用。 */
    is_enabled: z.boolean().default(true),
    /** 读取到的公开配置指纹；省略时兼容旧写入。 */
    expected_revision: managementRevisionSchema.optional(),
    /** 单次请求允许占用业务连接的最长时间，单位毫秒。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 当前 source_id 独立连接池的最大连接数。 */
    connection_pool_limit: z.number().int().min(1).max(100),
    /** 当前 source_id 同时执行的最大请求数。 */
    concurrency_limit: z.number().int().min(1).max(1000),
    /** 当前 source_id 单次响应允许返回的最大行数。 */
    row_limit: z.number().int().min(1).max(MAX_QUERY_ROWS),
    /** 兼容历史配置的成本字段；新配置可省略，该值不参与执行控制。 */
    cost_limit: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Oracle 使用连接方式与目标；其余数据库使用 target_database，两组配置互斥。
    if (value.connector_kind === "oracle") {
      if (value.oracle_connect_type === undefined || value.oracle_connect_target === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Oracle 数据源必须配置 oracle_connect_type 和 oracle_connect_target",
        });
      }
      if (value.target_database !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_database"],
          message: "Oracle 数据源不能配置 target_database",
        });
      }
      return;
    }

    if (value.target_database === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_database"],
        message: "数据库数据源必须配置 target_database",
      });
    }
    if (value.oracle_connect_type !== undefined || value.oracle_connect_target !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "数据库数据源不能配置 Oracle 连接目标",
      });
    }
  });

/** 管理端请求展开一个已保存 source_id 的完整业务对象目录，仅接受声明字段。 */
const sourceObjectDiscoveryRequestSchema = z
  .object({
    /** 需要展开完整对象目录的已保存数据源。 */
    source_id: z.string().min(1),
  })
  .strict();

/** 管理端提交的对象白名单选择项，仅接受声明字段。 */
const sourceObjectSelectionSchema = z
  .object({
    /** 管理端从当前数据源目录中勾选的对象标识。 */
    object_id: z
      .string()
      .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.$]*$/u)
      .max(256),
    /** 发现结果的标识用于校验物理映射；省略时使用逻辑标识。 */
    discovered_object_id: z.string().min(1).max(512).optional(),
    /** 省略时保留既有对象开关和能力。 */
    is_discoverable: z.boolean().optional(),
    is_queryable: z.boolean().optional(),
    query_capabilities: queryCapabilitiesSchema.optional(),
    /** 管理员核对的过程完整签名；省略时仅允许发现该过程。 */
    procedure_definition: procedureDefinitionSchema.nullable().optional(),
  })
  .strict();

/** 管理端替换一个 source_id 的 API 对象白名单，仅接受声明字段。 */
const sourceObjectSelectionRequestSchema = z
  .object({
    /** 要替换白名单的已保存数据源。 */
    source_id: z.string().min(1),
    /** 本次应暴露的完整对象集合；空列表表示清空白名单。 */
    objects: z.array(sourceObjectSelectionSchema).max(10000),
    /** 完整白名单替换的比较基准。 */
    expected_revision: managementRevisionSchema.optional(),
  })
  .strict();

/** 管理读取的公开配置包含停用与 HTTP API 源；数据库目标组合由持久化适配器校验。 */
const managedDataSourceSchema = z
  .object({
    source_id: z.string().min(1).max(128),
    connector_kind: z.enum(["sqlserver", "mysql", "postgresql", "oracle", "http_api"]),
    secret_ref: z.string().min(1).max(256),
    target_database: z.string().min(1).optional(),
    oracle_connect_type: z.enum(["sid", "service_name"]).optional(),
    oracle_connect_target: z.string().min(1).optional(),
    is_enabled: z.boolean(),
    timeout_ms: z.number().int().min(100).max(120000),
    connection_pool_limit: z.number().int().min(1).max(100),
    concurrency_limit: z.number().int().min(1).max(1000),
    row_limit: z.number().int().min(1).max(MAX_QUERY_ROWS),
    cost_limit: z.number().int().positive(),
  })
  .strict();
/** 删除同时核对配置和完整白名单，避免并发保存后被旧页面删除。 */
const deleteDataSourceSchema = z
  .object({
    source_id: z.string().min(1).max(128),
    expected_revision: managementRevisionSchema,
    expected_objects_revision: managementRevisionSchema,
  })
  .strict();
/** 不存在的源也有明确空基准，用于首次创建比较更新。 */
const managedDataSourceDetailSchema = z
  .object({ config: managedDataSourceSchema.nullable(), revision: managementRevisionSchema })
  .strict();
/** 白名单完整公开记录，物理映射只能从服务器实际发现结果取得。 */
const managedSourceObjectSchema = z
  .object({
    source_id: z.string().min(1).max(128),
    object_id: z
      .string()
      .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.$]*$/u)
      .max(256),
    object_kind: z.enum(["table", "view", "stored_procedure", "api_dataset"]),
    native_schema_name: z.string().min(1).optional(),
    native_object_name: z.string().min(1).optional(),
    is_discoverable: z.boolean(),
    is_queryable: z.boolean(),
    query_capabilities: queryCapabilitiesSchema,
    procedure_definition: procedureDefinitionSchema.optional(),
  })
  .strict();
/** 白名单的顺序固定为逻辑 ID，指纹覆盖完整持久化定义。 */
const managedSourceObjectsSchema = z
  .object({
    items: z.array(managedSourceObjectSchema).max(10000),
    revision: managementRevisionSchema,
  })
  .strict();
/** 凭据仅公开引用、是否存在及关联源；不解密账号、主机或密码。 */
const managedSecretReferenceSchema = z
  .object({
    secret_ref: z.string().min(1).max(256),
    exists: z.boolean(),
    source_ids: z.array(z.string().min(1).max(128)),
  })
  .strict();
/** 目录发现保留当前驱动给出的字段与基础能力，按需用于映射选择。 */
const manageableSourceObjectSchema = z
  .object({
    object_id: z.string().min(1).max(512),
    kind: z.enum(["table", "view", "stored_procedure", "api_dataset"]),
    native_schema_name: z.string().optional(),
    native_object_name: z.string(),
    source_description: z.string().optional(),
    columns: z.array(datasetColumnSchema),
    query_capabilities: queryCapabilitiesSchema.optional(),
  })
  .strict();

export {
  managementRevisionSchema,
  deleteDataSourceSchema,
  dataSourceManagementConfigSchema,
  databaseTargetDiscoveryRequestSchema,
  sharedDatabaseCredentialsSchema,
  sourceObjectDiscoveryRequestSchema,
  sourceObjectSelectionRequestSchema,
  managedDataSourceSchema,
  managedDataSourceDetailSchema,
  managedSourceObjectSchema,
  managedSourceObjectsSchema,
  managedSecretReferenceSchema,
  manageableSourceObjectSchema,
};
