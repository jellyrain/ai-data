import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { connect } from "../../ai-data/scripts/demo-data/database.mjs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const web = fileURLToPath(new URL("../../ai-data/apps/web/", import.meta.url)),
  out = join(dirname(fileURLToPath(import.meta.url)), "正式报表"),
  require = createRequire(join(web, "package.json"));
const config = JSON.parse(
  await readFile(
    new URL("../../ai-data/apps/api/config/api.config.json", import.meta.url),
    "utf8",
  ),
);
const { preview } = await import(pathToFileURL(require.resolve("vite"))),
  { chromium, expect } = require("@playwright/test"),
  ExcelJS = require("exceljs"),
  { unzipSync, strFromU8 } = require("fflate");
const ids = [
  { key: "门诊", id: "6590692f-afe6-44aa-abe9-b3c6519708c1" },
  { key: "住院", id: "4be90771-90a6-4598-9454-077cffed9762" },
  { key: "费用", id: "47dfa9e0-8e34-4999-b9be-475732e75dc2" },
];
const conversationOnly = process.argv.includes("--conversation-only");
const result = { checks: [], errors: [], writes: [] };
let browser, server, database;
const children = [];
async function healthy(port) {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(800),
      })
    ).ok;
  } catch {
    return false;
  }
}
async function startService(app, port) {
  if (await healthy(port)) return;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(`../../ai-data/apps/${app}/`, import.meta.url)),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + String(chunk)).slice(-800);
  });
  for (let attempts = 0; attempts < 100; attempts++) {
    if (await healthy(port)) return;
    if (child.exitCode !== null)
      throw new Error(`${app} 验收进程启动失败：${errors}`);
    await delay(500);
  }
  throw new Error(`${app} 验收进程启动超时`);
}
const countSql = [
  "report_templates",
  "report_template_versions",
  "saved_reports",
  "report_executions",
  "report_narratives",
  "analysis_runs",
  "analysis_evidence",
  "analysis_tool_audits",
  "analysis_run_events",
  "model_configuration_versions",
]
  .map(
    (table) =>
      `SELECT '${table}' AS table_name, COUNT_BIG(*) AS total FROM dbo.[${table}]`,
  )
  .join(" UNION ALL ");
try {
  await mkdir(out, { recursive: true });
  await startService("api", 3101);
  await startService("data-access", 3102);
  database = await connect(config.metadata_sqlserver.database);
  result.before = (await database.request().query(countSql)).recordset;
  server = await preview({
    root: web,
    preview: { host: "127.0.0.1", port: 5349, strictPort: true },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20000);
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      result.writes.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
  });
  page.on("pageerror", (error) => result.errors.push(error.message));
  await page.goto("http://127.0.0.1:5349/login");
  await page
    .getByLabel("用户名", { exact: true })
    .fill(config.bootstrap_admin.username);
  await page
    .getByLabel("密码", { exact: true })
    .fill(config.bootstrap_admin.password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "分析工作台", exact: true }),
  ).toBeVisible();
  for (const report of conversationOnly ? [] : ids) {
    await page.goto(`http://127.0.0.1:5349/reports/${report.id}`);
    try {
      await expect(page.locator(".report-result-heading h2")).toBeVisible({
        timeout: 25000,
      });
    } catch (error) {
      result.checks.push({
        report: report.key,
        alerts: await page.getByRole("alert").allTextContents(),
      });
      await page.screenshot({ path: join(out, `${report.key}-读取失败.png`) });
      throw error;
    }
    const packPromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/export-content") &&
        response.request().method() === "GET",
    );
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const response = await packPromise;
    assert.equal(response.status(), 200);
    const pack = await response.json();
    assert.equal(pack.kind, "report_execution");
    assert.equal(pack.execution.report_id, report.id);
    const tables = [
      ...new Map(
        pack.execution.results.map((item) => [
          item.evidence.evidence_id,
          item.evidence,
        ]),
      ).values(),
    ];
    for (const [format, extension] of [
      ["Excel", "xlsx"],
      ["Word", "docx"],
      ["PDF", "pdf"],
    ]) {
      await page.getByRole("combobox", { name: "文件格式" }).press("Enter");
      await page
        .getByRole("option", { name: new RegExp(`^${format}`) })
        .click();
      await page.getByRole("button", { name: "生成文件", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "下载文件", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载文件", exact: true }).click();
      const path = join(out, `${report.key}.${extension}`);
      await (await downloading).saveAs(path);
      const bytes = await readFile(path);
      if (extension === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(bytes);
        assert.equal(workbook.worksheets.length, tables.length + 1);
        for (const table of tables) {
          const expected = [
            table.result.columns.map((c) => c.name),
            ...table.result.rows.map((row) =>
              table.result.columns.map((c) => row[c.name] ?? null),
            ),
          ];
          assert.ok(
            workbook.worksheets
              .slice(1)
              .some(
                (sheet) =>
                  JSON.stringify(
                    Array.from({ length: sheet.rowCount }, (_, index) =>
                      Array.from(
                        { length: table.result.columns.length },
                        (_, col) => sheet.getCell(index + 1, col + 1).value,
                      ),
                    ),
                  ) === JSON.stringify(expected),
              ),
          );
        }
      }
      if (extension === "docx") {
        const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
        assert.ok(xml.includes(pack.execution.definition.title));
        assert.ok(xml.includes("<w:tbl>"));
      }
      if (extension === "pdf") {
        const pdfjs = await import(
            pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
          ),
          task = pdfjs.getDocument({ data: new Uint8Array(bytes) }),
          pdf = await task.promise;
        try {
          let text = "";
          for (let p = 1; p <= pdf.numPages; p++)
            text += (await (await pdf.getPage(p)).getTextContent()).items
              .map((item) => item.str ?? "")
              .join("");
          assert.ok(text.includes(pack.execution.definition.title));
          result.checks.push({
            report: report.key,
            format,
            pages: pdf.numPages,
            text_verified: true,
          });
        } finally {
          await task.destroy();
        }
      }
      result.checks.push({
        report: report.key,
        report_id: report.id,
        execution_id: pack.execution.execution_id,
        format,
        bytes: bytes.length,
        rows: tables.reduce((sum, table) => sum + table.result.rows.length, 0),
        passed: true,
      });
      console.log(`${report.key} ${format} 通过`);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".export-options")).not.toBeVisible();
  }
  if (conversationOnly) {
    const id = "8d5b1c59-2b07-453e-9217-5bf6cef8505d";
    await page.goto(`http://127.0.0.1:5349/analysis/${id}`);
    await expect(
      page.getByRole("button", { name: "导出", exact: true }),
    ).toBeEnabled({ timeout: 25000 });
    const reading = page.waitForResponse((response) =>
      response.url().endsWith(`/conversations/${id}/export-content`),
    );
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const response = await reading;
    assert.equal(response.status(), 200);
    const pack = await response.json();
    assert.equal(pack.kind, "conversation");
    assert.ok(pack.messages.length);
    assert.ok(
      pack.runs.every((run) =>
        ["completed", "failed", "cancelled"].includes(run.status),
      ),
    );
    for (const [format, extension] of [
      ["Excel", "xlsx"],
      ["Word", "docx"],
      ["PDF", "pdf"],
    ]) {
      await page.getByRole("combobox", { name: "文件格式" }).press("Enter");
      await page
        .getByRole("option", { name: new RegExp(`^${format}`) })
        .click();
      await page.getByRole("button", { name: "生成文件", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "下载文件", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载文件", exact: true }).click();
      const path = join(out, `已有费用会话.${extension}`);
      await (await downloading).saveAs(path);
      const bytes = await readFile(path);
      if (extension === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(bytes);
        assert.equal(
          workbook.worksheets.length,
          new Set(
            pack.tables
              .filter((table) => table.availability === "complete")
              .map((table) => table.evidence.evidence_id),
          ).size + 1,
        );
      }
      if (extension === "docx") {
        const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
        for (const message of pack.messages)
          assert.ok(xml.includes(message.role === "user" ? "用户" : "助手"));
        assert.ok(xml.includes(pack.title));
      }
      if (extension === "pdf") {
        const pdfjs = await import(
            pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
          ),
          task = pdfjs.getDocument({ data: new Uint8Array(bytes) }),
          pdf = await task.promise;
        assert.ok(pdf.numPages > 0);
        await task.destroy();
      }
      result.checks.push({
        conversation_id: id,
        format,
        bytes: bytes.length,
        messages: pack.messages.length,
        runs: pack.runs.length,
        passed: true,
      });
      console.log(`已有正式会话 ${format} 通过`);
    }
  }
  result.after = (await database.request().query(countSql)).recordset;
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.errors, []);
} catch (error) {
  result.errors.push(error.message);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close();
  await database?.close();
  await new Promise(
    (resolve) => server?.httpServer.close(resolve) ?? resolve(),
  );
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          child.once("exit", () => {
            clearTimeout(force);
            resolve();
          });
          const force = setTimeout(() => child.kill("SIGKILL"), 3000);
          child.kill("SIGTERM");
        }),
    ),
  );
  await writeFile(
    join(
      dirname(out),
      conversationOnly ? "正式会话只读导出.json" : "正式只读导出.json",
    ),
    JSON.stringify(result, null, 2),
  );
}
