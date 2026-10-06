import type { SqlServerTransport } from "@ai-data/contracts";

/** 业务连接按凭据、部署配置、默认值依次解析；发现目标库时省略部署配置。 */
function resolveSqlServerTransport(
  credential?: SqlServerTransport,
  deployment?: SqlServerTransport,
) {
  return {
    options: credential ?? deployment ?? { encrypt: true, trust_server_certificate: false },
    origin: credential
      ? ("credential" as const)
      : deployment
        ? ("deployment" as const)
        : ("default" as const),
  };
}
/** 统一转换为驱动参数，数据库发现与业务连接共用。 */
function sqlServerDriverOptions(credential?: SqlServerTransport, deployment?: SqlServerTransport) {
  const { options } = resolveSqlServerTransport(credential, deployment);
  return { encrypt: options.encrypt, trustServerCertificate: options.trust_server_certificate };
}
export { resolveSqlServerTransport, sqlServerDriverOptions };
