import { z } from "zod";
import {
  managementRevisionSchema,
  sharedDatabaseCredentialsSchema,
  databaseTargetDiscoveryRequestSchema,
} from "./data-source-management";
import { sqlServerTransportSchema } from "./sqlserver-transport";

/** 数据库连接的公开管理字段，仅管理权限可读取；密码与密文始终留在 DAS。 */
const databaseConnectionSchema = z
  .object({
    secret_ref: z.string().min(1).max(128),
    connector_kind: z.enum(["sqlserver", "mysql", "postgresql", "oracle"]),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1),
    sqlserver_transport: sqlServerTransportSchema.optional(),
    source_ids: z.array(z.string().min(1)),
    revision: managementRevisionSchema,
  })
  .strict();
/** 新建使用独立名称，重名请求不得覆盖已保存连接。 */
const createDatabaseConnectionSchema = sharedDatabaseCredentialsSchema.safeExtend({
  secret_ref: z.string().trim().min(1).max(128),
});
/** 编辑固定连接类型，空密码或省略密码保留原值；修订拒绝覆盖并发更新。 */
const updateDatabaseConnectionSchema = z
  .object({
    expected_revision: managementRevisionSchema,
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1),
    password: z.string().optional(),
    sqlserver_transport: sqlServerTransportSchema.optional(),
  })
  .strict();
/** 删除需使用当前修订；服务端同时检查所有数据源引用。 */
const deleteDatabaseConnectionSchema = z
  .object({ expected_revision: managementRevisionSchema })
  .strict();
/** 测试已保存连接，Oracle 需显式提供可连接的 SID 或 Service Name。 */
const testDatabaseConnectionSchema = z
  .object({
    oracle_connect_type: z.enum(["sid", "service_name"]).optional(),
    oracle_connect_target: z.string().min(1).optional(),
  })
  .strict();
/** 仅测试当前表单；编辑时按修订读取原密码，测试本身不保存任何连接字段。 */
const testDatabaseConnectionDraftSchema = z
  .object({
    connector_kind: sharedDatabaseCredentialsSchema.shape.connector_kind,
    host: sharedDatabaseCredentialsSchema.shape.host.trim(),
    port: sharedDatabaseCredentialsSchema.shape.port,
    user: sharedDatabaseCredentialsSchema.shape.user,
    password: z.string().optional(),
    sqlserver_transport: sqlServerTransportSchema.optional(),
    saved_connection: z
      .object({
        secret_ref: databaseConnectionSchema.shape.secret_ref,
        expected_revision: managementRevisionSchema,
      })
      .strict()
      .optional(),
    ...testDatabaseConnectionSchema.shape,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.saved_connection && !value.password)
      context.addIssue({ code: "custom", path: ["password"], message: "新建连接测试需要填写密码" });
    if (value.connector_kind !== "sqlserver" && value.sqlserver_transport !== undefined)
      context.addIssue({
        code: "custom",
        path: ["sqlserver_transport"],
        message: "仅 SQL Server 支持此连接选项",
      });
    const target = databaseTargetDiscoveryRequestSchema.safeParse({
      secret_ref: value.saved_connection?.secret_ref ?? "connection-test",
      connector_kind: value.connector_kind,
      oracle_connect_type: value.oracle_connect_type,
      oracle_connect_target: value.oracle_connect_target,
    });
    if (!target.success)
      for (const issue of target.error.issues)
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  deleteDatabaseConnectionSchema,
  testDatabaseConnectionSchema,
  testDatabaseConnectionDraftSchema,
};
