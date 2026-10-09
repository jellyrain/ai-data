import type { Page } from "@playwright/test";
import {
  databaseConnectionSchema,
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  dataSourceManagementConfigSchema,
  testDatabaseConnectionDraftSchema,
  type DatabaseConnection,
} from "@ai-data/contracts";
import { managementFixture } from "./management-fixture";
/** 新连接管理的隔离浏览器服务；SQL 加密及并发由 DAS 集成测试覆盖。 */
async function databaseConnectionFixture(page: Page, existing = false) {
  await managementFixture(page);
  let version = 1;
  const revision = () => String(version++).padStart(64, "0");
  const connections = new Map<string, DatabaseConnection>();
  const passwords = new Map<string, string>();
  const sources = new Map<string, ReturnType<typeof dataSourceManagementConfigSchema.parse>>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const tests: ReturnType<typeof testDatabaseConnectionDraftSchema.parse>[] = [];
  const mode = {
    conflict: false,
    dropReceipt: false,
    invalidReceipt: false,
    forbidden: false,
    failTest: false,
  };
  if (existing) {
    for (const [id, kind] of [
      ["hospital", "sqlserver"],
      ["archive", "mysql"],
    ] as const) {
      connections.set(id, {
        secret_ref: id,
        connector_kind: kind,
        host: `${id}.test`,
        port: kind === "sqlserver" ? 1433 : 3306,
        user: "reader",
        source_ids: [],
        revision: revision(),
        ...(kind === "sqlserver"
          ? { sqlserver_transport: { encrypt: true, trust_server_certificate: false } }
          : {}),
      });
      passwords.set(id, "original-password");
    }
  }
  await page.route("**/api/admin/data-access/services/*/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/").slice(6).join("/");
    if (!path.startsWith("database-connections") && !path.startsWith("data-sources"))
      return route.fallback();
    const method = route.request().method();
    const body = (method === "GET" ? {} : route.request().postDataJSON()) as Record<
      string,
      unknown
    >;
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });
    const fail = (code: string, status: number) =>
      send({ code, message: code, request_id: "fixture" }, status);
    if (mode.forbidden) return fail("UNAUTHORIZED", 403);
    if (method !== "GET") writes.push({ path, body });
    if (path === "database-connections/test" && method === "POST") {
      const draft = testDatabaseConnectionDraftSchema.parse(body);
      tests.push(draft);
      if (draft.saved_connection) {
        const saved = connections.get(draft.saved_connection.secret_ref);
        if (!saved) return fail("NOT_FOUND", 404);
        if (saved.revision !== draft.saved_connection.expected_revision)
          return fail("CONFLICT", 409);
      }
      return mode.failTest
        ? fail("DATA_SOURCE_UNAVAILABLE", 503)
        : send({ databases: [{ name: "business", connect_target: "business" }] });
    }
    if (path.startsWith("data-sources")) {
      if (path === "data-sources" && method === "GET")
        return send({ items: [...sources.values()].map((s) => ({ ...s, cost_limit: 1 })) });
      if (path === "data-sources") {
        const input = dataSourceManagementConfigSchema.parse(body);
        const c = connections.get(input.secret_ref);
        if (!c || c.connector_kind !== input.connector_kind) return fail("INVALID_INPUT", 400);
        const { expected_revision, ...saved } = input;
        void expected_revision;
        sources.set(input.source_id, saved);
        c.source_ids.push(input.source_id);
        return send({ source_id: input.source_id });
      }
      const source = sources.get(decodeURIComponent(path.split("/")[1]!));
      return send({
        config: source ? { ...source, cost_limit: 1 } : null,
        revision: "0".repeat(64),
      });
    }
    if (path === "database-connections") {
      if (method === "GET") return send({ items: [...connections.values()] });
      const input = createDatabaseConnectionSchema.parse(body);
      if (connections.has(input.secret_ref)) return fail("CONFLICT", 409);
      const { password, ...fields } = input;
      passwords.set(input.secret_ref, password);
      const value = databaseConnectionSchema.parse({
        ...fields,
        source_ids: [],
        revision: revision(),
      });
      connections.set(input.secret_ref, value);
      return mode.dropReceipt
        ? fail("INTERNAL_ERROR", 500)
        : send(mode.invalidReceipt ? {} : value);
    }
    const [, encoded, action] = path.split("/");
    const id = decodeURIComponent(encoded!);
    const value = connections.get(id);
    if (!value) return fail("NOT_FOUND", 404);
    if (action === "test")
      return mode.failTest
        ? fail("DATA_SOURCE_UNAVAILABLE", 503)
        : send({ databases: [{ name: "business", connect_target: "business" }] });
    if (action === "delete") {
      if (value.source_ids.length || body.expected_revision !== value.revision)
        return fail("CONFLICT", 409);
      connections.delete(id);
      passwords.delete(id);
      return send({ secret_ref: id });
    }
    if (method === "GET") return send(value);
    const input = updateDatabaseConnectionSchema.parse(body);
    if (mode.conflict || input.expected_revision !== value.revision) return fail("CONFLICT", 409);
    const { expected_revision, password, ...fields } = input;
    void expected_revision;
    if (password) passwords.set(id, password);
    Object.assign(value, fields, { revision: revision() });
    return mode.dropReceipt ? fail("INTERNAL_ERROR", 500) : send(mode.invalidReceipt ? {} : value);
  });
  return { connections, passwords, sources, writes, tests, mode };
}
export { databaseConnectionFixture };
