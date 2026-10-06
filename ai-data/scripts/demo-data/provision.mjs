import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { request, administrator } from "./api.mjs";
import { configuration, connect, sql } from "./database.mjs";
import { defineTables } from "./schema.mjs";
const source = "clinical-demo";
const evidence = new URL("../../../任务交接/前端第4步业务造数与验收/", import.meta.url);
const progressFile = new URL("接入进度.json", evidence);
const accountFile = new URL("../../apps/api/secrets/clinical-demo-accounts.json", import.meta.url);
/** 通过真实管理接口发布目录；两个演示角色仅在元数据初始化时创建。 */
async function provision() {
  const tables = defineTables(),
    connection = configuration();
  const secret = JSON.parse(
    readFileSync(
      new URL("../../apps/data-access/secrets/clinical-demo.json", import.meta.url),
      "utf8",
    ),
  );
  const state = existsSync(progressFile)
    ? JSON.parse(readFileSync(progressFile, "utf8"))
    : { completed: [], users: {} };
  const record = () => writeFileSync(progressFile, JSON.stringify(state, null, 2) + "\n");
  const once = async (key, run) => {
    if (state.completed.includes(key)) return;
    await run();
    state.completed.push(key);
    record();
  };
  const login = await administrator(),
    token = login.accessToken;
  const base = "/admin/data-access/services/data-access-service/";
  await once("secret", () =>
    request(base + "data-source-secrets", token, {
      secret_ref: source,
      connector_kind: "sqlserver",
      host: connection.server,
      port: connection.port,
      user: secret.user,
      password: secret.password,
    }),
  );
  await once("source-capacity-16", () =>
    request(
      base + "data-sources",
      token,
      {
        source_id: source,
        connector_kind: "sqlserver",
        secret_ref: source,
        target_database: "ai_bi_demo",
        timeout_ms: 30000,
        connection_pool_limit: 8,
        concurrency_limit: 16,
        row_limit: 5000,
      },
      "PUT",
    ),
  );
  await once("objects", () =>
    request(
      base + "data-source-objects",
      token,
      { source_id: source, objects: tables.map((t) => ({ object_id: "table.dbo." + t.name })) },
      "PUT",
    ),
  );
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const catalog = await request("/catalog/datasets/" + source, token);
      if (catalog.items.length === 24) {
        ready = true;
        break;
      }
    } catch {
      /* 等待 DAS 上报新源健康状态。 */
    }
    await setTimeout(1500);
  }
  if (!ready) throw new Error("DAS 尚未上报完整 24 表目录");
  const metadata = await connect(connection.database);
  try {
    for (const [id, name] of [
      ["demo-analyst", "演示全量分析"],
      ["demo-dept-reader", "演示内科分析"],
    ])
      await once("role:" + id, async () => {
        await metadata
          .request()
          .input("id", sql.NVarChar, id)
          .input("name", sql.NVarChar, name)
          .query(
            "IF EXISTS (SELECT 1 FROM dbo.roles WHERE (id=@id OR code=@id) AND (id<>@id OR code<>@id OR name<>@name)) THROW 51000,'演示角色名称冲突',1; IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE id=@id) INSERT dbo.roles(id,code,name) VALUES(@id,@id,@name)",
          );
      });
  } finally {
    await metadata.close();
  }
  mkdirSync(new URL("../../apps/api/secrets/", import.meta.url), { recursive: true });
  let accounts;
  if (existsSync(accountFile)) accounts = JSON.parse(readFileSync(accountFile, "utf8"));
  else {
    accounts = [
      { username: "demo_full", role: "demo-analyst", display_name: "演示全量分析员" },
      { username: "demo_dept", role: "demo-dept-reader", display_name: "演示内科分析员" },
    ].map((account) => ({ ...account, password: randomBytes(24).toString("base64url") + "!A1" }));
    writeFileSync(accountFile, JSON.stringify(accounts, null, 2) + "\n", { flag: "wx" });
  }
  const users = (await request("/admin/users", token)).items;
  for (const account of accounts)
    await once("user:" + account.username, async () => {
      const user =
        users.find((u) => u.username === account.username) ??
        (await request("/admin/users", token, {
          username: account.username,
          display_name: account.display_name,
          password: account.password,
          role_ids: [account.role],
        }));
      state.users[account.username] = user.id;
    });
  for (const table of tables) {
    const object = "table.dbo." + table.name;
    await once("config:" + table.name, () =>
      request(
        "/admin/catalog/datasets",
        token,
        {
          source_id: source,
          object_id: object,
          expected_version: 0,
          business_description:
            table.label +
            "。演示数据截至2026-09-27；金额单位分。" +
            (table.name.includes("deposit")
              ? "预交金 apply 为抵扣、receive 为收款、return 为余额退款；抵扣不重复计收入。"
              : ""),
          grain: "每行一个" + table.label,
          unique_keys: [[table.key]],
          approved_relations: [],
          column_descriptions: table.columns.map((c) => ({
            field: c.name,
            business_description:
              c.label +
              (c.name === "status"
                ? "；completed为完成，partial为部分支付，inpatient为在院，discharged为出院，posted为有效费用。"
                : ""),
          })),
          column_policies: [],
        },
        "PUT",
      ),
    );
    for (const role of ["demo-analyst", "demo-dept-reader"]) {
      await once("object:" + role + ":" + table.name, () =>
        request(
          "/admin/catalog/object-permissions",
          token,
          {
            source_id: source,
            role_id: role,
            object_id: object,
            effect: role === "demo-dept-reader" && table.name === "patients" ? "deny" : "allow",
          },
          "PUT",
        ),
      );
      if (role === "demo-dept-reader" && table.columns.some((c) => c.name === "department_id"))
        await once("row:" + table.name, () =>
          request(
            "/admin/catalog/row-policies",
            token,
            {
              source_id: source,
              role_id: role,
              object_id: object,
              effect: "allow",
              condition: { field: "department_id", op: "eq", value: 1 },
            },
            "PUT",
          ),
        );
    }
  }
  const changes = [];
  for (const table of tables)
    for (const col of table.columns.filter((c) => c.target && c.target !== table.name)) {
      const target = tables.find((t) => t.name === col.target);
      const pair = { source_column: col.name, target_column: target.key };
      changes.push({
        action: "create",
        object_id: "table.dbo." + table.name,
        relation: {
          relation_id: "rel_" + table.name + "_" + col.name,
          target_object_id: "table.dbo." + target.name,
          description: table.label + "按" + col.label + "关联" + target.label,
          column_pairs: [pair],
          cardinality: "many_to_one",
          allowed_join_types: ["inner", "left"],
        },
      });
      changes.push({
        action: "create",
        object_id: "table.dbo." + target.name,
        relation: {
          relation_id: "rel_" + table.name + "_" + col.name + "_reverse",
          target_object_id: "table.dbo." + table.name,
          description:
            target.label +
            "关联" +
            table.label +
            "，子表可能多行；人次按主键去重，金额先聚合以避免重复",
          column_pairs: [{ source_column: target.key, target_column: col.name }],
          cardinality: "one_to_many",
          allowed_join_types: ["inner", "left"],
        },
      });
    }
  for (let i = 0; i < changes.length; i += 50)
    await once("relations:" + i, () =>
      request("/admin/catalog/" + source + "/relations/publish", token, {
        changes: changes.slice(i, i + 50),
      }),
    );
  // 账号和目录均重新读回；日志仅保存身份与可见对象数量。
  const checks = [];
  for (const account of accounts) {
    const session = await request("/auth/login", null, {
      username: account.username,
      password: account.password,
    });
    const catalog = await request("/catalog/datasets/" + source, session.accessToken);
    checks.push({ username: account.username, object_count: catalog.items.length });
    await request("/auth/logout", session.accessToken, { refresh_token: session.refreshToken });
  }
  writeFileSync(
    new URL("接入验收.json", evidence),
    JSON.stringify(
      {
        source_id: source,
        table_count: tables.length,
        published_relations: changes.length,
        checks,
      },
      null,
      2,
    ) + "\n",
  );
  await request("/auth/logout", token, { refresh_token: login.refreshToken });
  process.stdout.write(
    JSON.stringify({ source_id: source, table_count: 24, relations: changes.length, checks }) +
      "\n",
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  provision().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
export { provision };
