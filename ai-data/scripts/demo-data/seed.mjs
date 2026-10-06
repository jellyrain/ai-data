import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";
import { assertTarget, connect, sql } from "./database.mjs";
import { buildFixture, validateFixture } from "./fixture.mjs";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const target = "ai_bi_demo";
const marker = "clinical-demo-20260927-v1";
const evidence = new URL("../../../任务交接/前端第4步业务造数与验收/", import.meta.url);
const secretDirectory = new URL("../../apps/data-access/secrets/", import.meta.url);
const secretFile = new URL("clinical-demo.json", secretDirectory);

/** 专用库首次建表与批量导入在同一事务中完成；已有库必须具有本脚本标识。 */
async function seed() {
  assertTarget(target);
  const tables = buildFixture();
  const checked = validateFixture(tables);
  const admin = await connect("master");
  let database;
  try {
    const existing = await admin
      .request()
      .input("name", sql.NVarChar, target)
      .query("SELECT DB_ID(@name) AS id");
    if (!existing.recordset[0].id) {
      await admin.request().query("CREATE DATABASE [ai_bi_demo]");
      database = await connect(target);
      await database
        .request()
        .input("value", sql.NVarChar, marker)
        .query("EXEC sys.sp_addextendedproperty @name=N'ai_bi_demo_seed',@value=@value");
    } else {
      database = await connect(target);
      const owned = await database
        .request()
        .query(
          "SELECT CAST(value AS NVARCHAR(100)) AS value FROM sys.extended_properties WHERE class=0 AND name=N'ai_bi_demo_seed'",
        );
      if (owned.recordset[0]?.value !== marker)
        throw new Error("目标库已存在且不是本轮演示库，停止写入");
    }
    const count = (await database.request().query("SELECT COUNT(*) AS n FROM sys.tables"))
      .recordset[0].n;
    if (count === 0) {
      const transaction = new sql.Transaction(database);
      await transaction.begin();
      try {
        for (const table of tables) {
          const columns = table.columns.map(
            (col) =>
              `[${col.name}] ${col.type === "int" ? "INT" : col.type === "time" ? "DATETIME2(0)" : "NVARCHAR(200)"} ${col.nullable ? "NULL" : "NOT NULL"}${col.name === table.key ? " PRIMARY KEY" : ""}`,
          );
          await transaction
            .request()
            .query(`CREATE TABLE dbo.[${table.name}] (${columns.join(",")})`);
          for (let start = 0; start < table.rows.length; start += 10000) {
            const batch = new sql.Table("dbo." + table.name);
            for (const col of table.columns)
              batch.columns.add(
                col.name,
                col.type === "int"
                  ? sql.Int
                  : col.type === "time"
                    ? sql.DateTime2(0)
                    : sql.NVarChar(200),
                { nullable: !!col.nullable },
              );
            for (const row of table.rows.slice(start, start + 10000))
              batch.rows.add(
                ...table.columns.map((col) =>
                  row[col.name] !== null && col.type === "time"
                    ? dayjs(row[col.name]).utc(true).toDate()
                    : row[col.name],
                ),
              );
            await transaction.request().bulk(batch, { checkConstraints: true });
          }
          process.stdout.write(`已导入 ${table.name}: ${table.rows.length}\n`);
        }
        for (const table of tables) {
          for (const col of table.columns) {
            if (col.target) {
              const key = tables.find((t) => t.name === col.target).key;
              await transaction
                .request()
                .query(
                  `ALTER TABLE dbo.[${table.name}] ADD CONSTRAINT [fk_${table.name}_${col.name}] FOREIGN KEY ([${col.name}]) REFERENCES dbo.[${col.target}]([${key}])`,
                );
            }
            if ((col.target && col.name !== table.key) || col.type === "time")
              await transaction
                .request()
                .query(
                  `CREATE INDEX [ix_${table.name}_${col.name}] ON dbo.[${table.name}]([${col.name}])`,
                );
            await transaction
              .request()
              .input("table", sql.NVarChar, table.name)
              .input("column", sql.NVarChar, col.name)
              .input("description", sql.NVarChar, col.label)
              .query(
                "EXEC sys.sp_addextendedproperty @name=N'MS_Description',@value=@description,@level0type=N'SCHEMA',@level0name=N'dbo',@level1type=N'TABLE',@level1name=@table,@level2type=N'COLUMN',@level2name=@column",
              );
          }
          await transaction
            .request()
            .input("table", sql.NVarChar, table.name)
            .input("description", sql.NVarChar, table.label + "；合成验收数据；金额单位为分")
            .query(
              "EXEC sys.sp_addextendedproperty @name=N'MS_Description',@value=@description,@level0type=N'SCHEMA',@level0name=N'dbo',@level1type=N'TABLE',@level1name=@table",
            );
        }
        await transaction
          .request()
          .query("CREATE UNIQUE INDEX ux_visits_registration ON dbo.visits(registration_id)");
        for (const prefix of ["outpatient", "inpatient"]) {
          await transaction.request()
            .query(`ALTER TABLE dbo.${prefix}_charge_details ADD CONSTRAINT ck_${prefix}_charge_amount CHECK(amount_cents=quantity*unit_price_cents AND unit_price_cents>0);
            ALTER TABLE dbo.${prefix}_settlements ADD CONSTRAINT ck_${prefix}_settlement_amount CHECK(due_cents=fee_cents-discount_cents AND due_cents=patient_due_cents+insurance_due_cents AND unpaid_cents>=0);
            ALTER TABLE dbo.${prefix}_payments ADD CONSTRAINT ck_${prefix}_payment_amount CHECK(amount_cents>0);
            ALTER TABLE dbo.${prefix}_refunds ADD CONSTRAINT ck_${prefix}_refund_amount CHECK(amount_cents>0)`);
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback().catch(() => {});
        throw error;
      }
    } else if (count !== 24) throw new Error("目标库表数量与清单不符，停止继续");
    mkdirSync(secretDirectory, { recursive: true });
    let credentials;
    if (existsSync(secretFile)) credentials = JSON.parse(readFileSync(secretFile, "utf8"));
    else {
      const login = (
        await admin
          .request()
          .query("SELECT name FROM sys.sql_logins WHERE name=N'ai_bi_demo_reader'")
      ).recordset;
      if (login.length) throw new Error("只读登录已存在且缺少本轮凭据文件，停止覆盖");
      credentials = {
        database: target,
        user: "ai_bi_demo_reader",
        password: randomBytes(30).toString("base64url") + "!aA1",
      };
      writeFileSync(secretFile, JSON.stringify(credentials, null, 2) + "\n", { flag: "wx" });
    }
    await admin
      .request()
      .input("password", sql.NVarChar, credentials.password)
      .query(
        "IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name=N'ai_bi_demo_reader') BEGIN DECLARE @statement NVARCHAR(MAX)=N'CREATE LOGIN [ai_bi_demo_reader] WITH PASSWORD='+QUOTENAME(@password,CHAR(39))+N', CHECK_POLICY=ON, DEFAULT_DATABASE=[ai_bi_demo]'; EXEC sp_executesql @statement; END",
      );
    await database
      .request()
      .query(
        "IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name=N'ai_bi_demo_reader') CREATE USER [ai_bi_demo_reader] FOR LOGIN [ai_bi_demo_reader]; GRANT SELECT ON SCHEMA::dbo TO [ai_bi_demo_reader]",
      );
    const reader = await connect(target, {
      user: credentials.user,
      password: credentials.password,
    });
    try {
      const permissions = (
        await reader
          .request()
          .query(
            "SELECT HAS_PERMS_BY_NAME('dbo.visits','OBJECT','SELECT') AS can_read,HAS_PERMS_BY_NAME('dbo.visits','OBJECT','INSERT') AS can_insert,HAS_PERMS_BY_NAME('dbo.visits','OBJECT','UPDATE') AS can_update,HAS_PERMS_BY_NAME('dbo.visits','OBJECT','DELETE') AS can_delete",
          )
      ).recordset[0];
      if (
        permissions.can_read !== 1 ||
        permissions.can_insert !== 0 ||
        permissions.can_update !== 0 ||
        permissions.can_delete !== 0
      )
        throw new Error("只读权限核对失败");
      const actual = [];
      for (const table of tables) {
        const result = await reader.request().query(`SELECT * FROM dbo.[${table.name}]`);
        const rows = result.recordset.map((row) =>
          Object.fromEntries(
            table.columns.map((col) => [
              col.name,
              col.type === "time" && row[col.name] !== null
                ? dayjs.utc(row[col.name]).format("YYYY-MM-DD HH:mm:ss")
                : row[col.name],
            ]),
          ),
        );
        if (rows.length !== table.rows.length) throw new Error(table.name + " 行数不符");
        actual.push({ ...table, rows });
      }
      const validated = validateFixture(actual);
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        new URL("数据库验收.json", evidence),
        JSON.stringify(
          {
            database: target,
            marker,
            ...validated,
            permissions,
            tables: actual.map((t) => ({ name: t.name, label: t.label, rows: t.rows.length })),
            validated: "独立读取数据库后的外键、对账及床位区间通过",
          },
          null,
          2,
        ) + "\n",
      );
      const dictionary = [
        "# 演示业务库数据字典",
        "",
        `库：\`${target}\`。数据基准：2026-09-27。金额字段单位为分。`,
        "",
      ];
      for (const table of tables)
        dictionary.push(
          `## ${table.label}（${table.name}）`,
          "",
          `主键：\`${table.key}\`；行数：${table.rows.length}。`,
          "",
          "| 字段 | 类型 | 含义 | 关联 |",
          "| --- | --- | --- | --- |",
          ...table.columns.map(
            (col) =>
              `| ${col.name} | ${col.type}${col.nullable ? "，可空" : ""} | ${col.label} | ${col.target ?? ""} |`,
          ),
          "",
        );
      writeFileSync(new URL("数据字典.md", evidence), dictionary.join("\n"));
      process.stdout.write(
        JSON.stringify({ database: target, ...checked, readback: validated, permissions }) + "\n",
      );
    } finally {
      await reader.close();
    }
  } finally {
    await database?.close();
    await admin.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  seed().catch((error) => {
    process.stderr.write(`造数失败: ${error.code ?? ""} ${error.message}\n`);
    process.exitCode = 1;
  });
export { seed };
