import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { writeFile } from "node:fs/promises";
const web = fileURLToPath(new URL("../../ai-data/apps/web/", import.meta.url)),
  out = dirname(fileURLToPath(import.meta.url)),
  require = createRequire(join(web, "package.json"));
const { build, preview } = await import(pathToFileURL(require.resolve("vite"))),
  { chromium } = require("@playwright/test"),
  { unzipSync, strFromU8 } = require("fflate");
const outDir = join(web, "test-results/export-capacity-build"),
  results = {
    scope: "本地生成器容量，不调用 API 或模型",
    checks: [],
    errors: [],
  };
let browser, server;
try {
  await build({
    configFile: false,
    root: web,
    worker: { format: "es" },
    build: {
      outDir,
      emptyOutDir: false,
      rolldownOptions: {
        input: join(web, "tests/support/exports/capacity.html"),
      },
    },
    logLevel: "warn",
  });
  server = await preview({
    configFile: false,
    root: web,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 5348, strictPort: true },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto("http://127.0.0.1:5348/tests/support/exports/capacity.html");
  await page.waitForFunction(
    () => typeof window.runExportCapacity === "function",
  );
  for (const cancel of [true, false]) {
    const { bytes, ...result } = await page.evaluate(
      (cancel) => window.runExportCapacity(cancel),
      cancel,
    );
    assert.equal(result.cancelled, cancel);
    assert.equal(result.created, 1);
    assert.equal(result.terminated, 1);
    assert.ok(result.ticks > 0);
    if (!cancel) {
      const buffer = new Uint8Array(bytes);
      await writeFile(join(out, "容量100000行.xlsx"), buffer);
      const zip = unzipSync(buffer);
      let dataRows = 0,
        sheets = 0;
      for (const [path, value] of Object.entries(zip))
        if (
          /^xl\/worksheets\/sheet\d+\.xml$/.test(path) &&
          path !== "xl/worksheets/sheet1.xml"
        ) {
          const text = strFromU8(value),
            rows = (text.match(/<row\b/g) ?? []).length;
          assert.equal(rows, 5001);
          assert.ok(text.includes('r="D5001"'));
          dataRows += rows - 1;
          sheets++;
        }
      assert.equal(dataRows, 100000);
      assert.equal(sheets, 20);
      result.rows = dataRows;
      result.tables = sheets;
      result.file_bytes = buffer.length;
    }
    results.checks.push(result);
    console.log(JSON.stringify(result));
  }
  assert.deepEqual(results.errors, []);
} catch (error) {
  results.errors.push(error.message);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await browser?.close();
  await new Promise(
    (resolve) => server?.httpServer.close(resolve) ?? resolve(),
  );
  await writeFile(
    join(out, "导出容量验证.json"),
    JSON.stringify(results, null, 2),
  );
}
