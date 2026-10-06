import { readFileSync } from "node:fs";
import { URL } from "node:url";
/** 正式服务本机请求封装；错误记录不包含请求体和认证信息。 */
async function request(path, token, body, method = body === undefined ? "GET" : "POST") {
  const response = await globalThis.fetch("http://127.0.0.1:3101" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(160000),
  });
  const value = response.status === 204 ? undefined : await response.json();
  if (!response.ok)
    throw new Error(
      `${path}: ${response.status} ${value?.code ?? value?.error?.code ?? ""} ${value?.message ?? ""}`,
    );
  return value;
}
/** 密码仅用于已获准的本机登录，不写入验收记录。 */
async function administrator() {
  const config = JSON.parse(
    readFileSync(new URL("../../apps/api/config/api.config.json", import.meta.url), "utf8"),
  );
  return request("/auth/login", null, {
    username: config.bootstrap_admin.username,
    password: config.bootstrap_admin.password,
  });
}
export { request, administrator };
