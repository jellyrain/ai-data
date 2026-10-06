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
const pdfjs = await import(
    pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
  ),
  canvasRequire = createRequire(require.resolve("pdfjs-dist/package.json")),
  { createCanvas } = canvasRequire("@napi-rs/canvas");
const outDir = join(web, "test-results/export-layout-build"),
  result = { checks: [], errors: [] };
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
        input: join(web, "tests/support/exports/layout.html"),
      },
    },
    logLevel: "warn",
  });
  server = await preview({
    configFile: false,
    root: web,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 5350, strictPort: true },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => result.errors.push(e.message));
  await page.goto("http://127.0.0.1:5350/tests/support/exports/layout.html");
  await page.waitForFunction(
    () => typeof window.runDocumentLayout === "function",
  );
  await page.route("**/fonts/**", (route) =>
    route.fulfill({ status: 404, body: "missing" }),
  );
  const failure = await page.evaluate(async () => {
    try {
      await window.runDocumentLayout("pdf", true);
      return "";
    } catch (e) {
      return e.message;
    }
  });
  assert.ok(failure.includes("字体读取失败"));
  result.checks.push({ font_failure: failure });
  await page.unroute("**/fonts/**");
  for (const empty of [true, false])
    for (const format of ["pdf", "docx"]) {
      const bytes = new Uint8Array(
          await page.evaluate(
            ({ format, empty }) => window.runDocumentLayout(format, empty),
            { format, empty },
          ),
        ),
        name = empty ? "空文档" : "长标题200行宽表";
      await writeFile(join(out, `${name}.${format}`), bytes);
      if (format === "docx") {
        const zip = unzipSync(bytes),
          xml = strFromU8(zip["word/document.xml"]);
        assert.ok(xml.includes(empty ? "空文档验收" : "终值200"));
        if (!empty) {
          assert.ok(xml.includes("200 / 200"));
          assert.ok(xml.includes('w:orient="landscape"'));
          assert.equal(
            Object.keys(zip).filter(
              (p) => p.startsWith("word/media/") && p.endsWith(".png"),
            ).length,
            2,
          );
        }
        result.checks.push({ name, format, passed: true, bytes: bytes.length });
      } else {
        const fileBytes = bytes.length,
          task = pdfjs.getDocument({ data: bytes }),
          pdf = await task.promise;
        try {
          let text = "";
          for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p),
              viewport = page.getViewport({ scale: 1 }),
              canvas = createCanvas(
                Math.ceil(viewport.width),
                Math.ceil(viewport.height),
              );
            text += (await page.getTextContent()).items
              .map((i) => i.str ?? "")
              .join("");
            await page.render({
              canvasContext: canvas.getContext("2d"),
              canvas,
              viewport,
            }).promise;
            await writeFile(
              join(out, `${name}-${p}.png`),
              canvas.toBuffer("image/png"),
            );
          }
          assert.ok(text.includes(empty ? "空文档验收" : "终值200"));
          if (!empty) {
            assert.ok(text.includes("200 / 200"));
            assert.ok(text.includes("第 45 行"));
            assert.ok(text.includes("列组 2 / 2"));
          }
          result.checks.push({
            name,
            format,
            passed: true,
            pages: pdf.numPages,
            bytes: fileBytes,
          });
        } finally {
          await task.destroy();
        }
      }
    }
  assert.deepEqual(result.errors, []);
} catch (e) {
  result.errors.push(e.message);
  process.exitCode = 1;
  console.error(e.message);
} finally {
  await browser?.close();
  await new Promise(
    (resolve) => server?.httpServer.close(resolve) ?? resolve(),
  );
  await writeFile(
    join(out, "文件版式边界验证.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
