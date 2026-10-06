import { createRequire } from "node:module";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
const require = createRequire(new URL("../../packages/metadata/package.json", import.meta.url));
const sql = require("mssql");
/** 数据准备只能写入本轮获准的固定演示库。 */
function assertTarget(name) {
  if (name !== "ai_bi_demo") throw new Error("写入目标必须为 ai_bi_demo");
}
/** 从现有本地配置读取凭据，调用者不得打印连接对象。 */
function configuration() {
  return JSON.parse(
    readFileSync(new URL("../../apps/api/config/api.config.json", import.meta.url), "utf8"),
  ).metadata_sqlserver;
}
/** 单次脚本连接；SQL Server 的 datetime2 在合成数据中固定为东八区业务墙钟时间。 */
async function connect(database, override = {}) {
  const c = configuration();
  return new sql.ConnectionPool({
    server: c.server,
    port: c.port,
    user: c.user,
    password: c.password,
    database,
    connectionTimeout: 10000,
    requestTimeout: 120000,
    options: {
      encrypt: c.options.encrypt,
      trustServerCertificate: c.options.trust_server_certificate,
    },
    pool: { max: 2, min: 0 },
    ...override,
  }).connect();
}
export { assertTarget, configuration, connect, sql };
