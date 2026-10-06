import { z } from "zod";

/** 业务 SQL Server 的连接选项；两个布尔值独立，未知字段拒绝。 */
const sqlServerTransportSchema = z
  .object({
    /** 请求传输加密；服务器仍可强制加密。 */
    encrypt: z.boolean(),
    /** 显式信任服务器证书，跳过证书校验。 */
    trust_server_certificate: z.boolean(),
  })
  .strict();
/** 业务连接选项的管理回读，不包含服务器登录资料。 */
const managedSqlServerTransportSchema = z
  .object({
    secret_ref: z.string().min(1).max(256),
    connector_kind: z.literal("sqlserver"),
    sqlserver_transport: sqlServerTransportSchema,
    /** 凭据尚未保存选项时，回读的是服务器级数据库发现默认值。 */
    origin: z.enum(["credential", "default"]),
    /** 完整密文记录的修订指纹，参数或密码更新都会使旧基准失效。 */
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    /** 同一凭据关联源各自的实际选项；旧凭据可能按源回退到部署配置。 */
    sources: z.array(
      z
        .object({
          source_id: z.string().min(1).max(128),
          sqlserver_transport: sqlServerTransportSchema,
          origin: z.enum(["credential", "deployment", "default"]),
        })
        .strict(),
    ),
  })
  .strict();
/** 局部更新连接选项；基准绑定完整密文，阻止覆盖已轮换的密码。 */
const sqlServerTransportUpdateSchema = z
  .object({
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
    sqlserver_transport: sqlServerTransportSchema,
  })
  .strict();
export {
  sqlServerTransportSchema,
  managedSqlServerTransportSchema,
  sqlServerTransportUpdateSchema,
};
