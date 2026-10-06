import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 通过 Web 自己的依赖入口运行验收；不安装包、不连接业务 API。
const web = fileURLToPath(new URL("../../ai-data/apps/web/", import.meta.url));
const evidence = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(web, "package.json"));
const { build, preview } = await import(pathToFileURL(require.resolve("vite")));
const { chromium } = require("@playwright/test");
const ExcelJS = require("exceljs");
const { unzipSync, strFromU8 } = require("fflate");
const manifest = JSON.parse(
  await readFile(new URL("../前端第7步依赖核对.json", import.meta.url), "utf8"),
);
const result = {
  installed: [],
  dependency_scripts: [],
  fonts: [],
  checks: [],
  errors: [],
};
let browser;
let server;

/** 按 Node 的实际解析路径定位包元数据，兼容未导出 package.json 的依赖。 */
async function packagePath(name, from) {
  const scoped = createRequire(from);
  try {
    return scoped.resolve(`${name}/package.json`);
  } catch {
    let directory = dirname(scoped.resolve(name));
    while (dirname(directory) !== directory) {
      const candidate = join(directory, "package.json");
      try {
        if (JSON.parse(await readFile(candidate, "utf8")).name === name)
          return candidate;
      } catch {
        // 向上查找入口所属的包。
      }
      directory = dirname(directory);
    }
    throw new Error(`无法定位依赖元数据：${name}`);
  }
}

try {
  const queue = [];
  for (const item of manifest.packages) {
    const path = await packagePath(item.name, join(web, "package.json"));
    const actual = JSON.parse(await readFile(path, "utf8"));
    assert.equal(actual.version, item.version);
    assert.equal(actual.license, item.license);
    result.installed.push({
      name: actual.name,
      version: actual.version,
      license: actual.license,
    });
    queue.push(path);
  }
  const visited = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const pkg = JSON.parse(await readFile(path, "utf8"));
    const scripts = Object.fromEntries(
      Object.entries(pkg.scripts ?? {}).filter(([key]) =>
        ["preinstall", "install", "postinstall"].includes(key),
      ),
    );
    if (Object.keys(scripts).length) {
      result.dependency_scripts.push({
        name: pkg.name,
        version: pkg.version,
        scripts,
      });
    }
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      try {
        queue.push(await packagePath(name, path));
      } catch (error) {
        if (!pkg.optionalDependencies?.[name]) throw error;
      }
    }
  }
  result.resolved_dependency_count = visited.size;
  const modules = JSON.parse(
    await readFile(resolve(web, "../../node_modules/.modules.yaml"), "utf8"),
  );
  result.pending_builds = modules.pendingBuilds;
  result.allow_builds = modules.allowBuilds;
  assert.deepEqual(result.pending_builds, []);

  for (const font of manifest.fonts.files) {
    const path = join(web, "public/fonts/noto-sans-sc", font.name);
    try {
      const bytes = await readFile(path);
      const hash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(hash, font.sha256);
      assert.equal(bytes.length, font.bytes);
      result.fonts.push({
        name: font.name,
        verified: true,
        sha256: hash,
        bytes: bytes.length,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      result.fonts.push({
        name: font.name,
        verified: false,
        reason: "待用户下载",
      });
    }
  }
  const hasChineseFonts = result.fonts.every((font) => font.verified);
  const outDir = join(web, "test-results/export-compatibility-build");
  await mkdir(outDir, { recursive: true });
  await build({
    configFile: false,
    root: web,
    build: {
      outDir,
      emptyOutDir: false,
      rolldownOptions: {
        input: join(web, "tests/support/exports/compatibility.html"),
      },
    },
  });
  result.checks.push("Vite 独立生产构建通过");
  server = await preview({
    configFile: false,
    root: web,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 5347, strictPort: true },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => result.errors.push(error.message));
  await page.goto(
    "http://127.0.0.1:5347/tests/support/exports/compatibility.html",
  );
  await page.waitForFunction(
    () => typeof window.generateCompatibility === "function",
  );
  const cases = [
    { format: "xlsx", chinese: true, name: "兼容样例.xlsx" },
    { format: "docx", chinese: true, name: "兼容样例.docx" },
    { format: "pdf", chinese: false, name: "兼容样例-英文.pdf" },
    ...(hasChineseFonts
      ? [{ format: "pdf", chinese: true, name: "兼容样例-中文.pdf" }]
      : []),
  ];
  for (const sample of cases) {
    const data = await page.evaluate(
      (request) => window.generateCompatibility(request),
      { ...sample, fontBase: "http://127.0.0.1:5347/fonts/noto-sans-sc/" },
    );
    const bytes = new Uint8Array(data);
    await writeFile(join(evidence, sample.name), bytes);
    assert.ok(bytes.length > 1000);
    if (sample.format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      const sheet = workbook.getWorksheet("住院费用");
      assert.equal(sheet.rowCount, 3);
      assert.deepEqual(sheet.getRow(2).values.slice(1), [
        "心内科",
        12345.67,
        "00123",
        "=1+1",
        true,
      ]);
      assert.equal(sheet.getCell("D2").type, ExcelJS.ValueType.String);
      assert.equal(sheet.getCell("E3").value, false);
    } else if (sample.format === "docx") {
      const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
      for (const expected of [
        "住院费用兼容性验收",
        "心内科",
        "12345.67",
        "<w:tbl>",
        "<w:p>",
      ]) {
        assert.ok(xml.includes(expected), expected);
      }
    } else {
      const pdfjs = await import(
        pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
      );
      const loadingTask = pdfjs.getDocument({ data: bytes });
      const pdf = await loadingTask.promise;
      assert.equal(pdf.numPages, 2);
      let text = "";
      for (let index = 1; index <= pdf.numPages; index++) {
        const pdfPage = await pdf.getPage(index);
        const items = (await pdfPage.getTextContent()).items;
        text += items.map((item) => item.str ?? "").join(" ");
        if (sample.chinese && index === 1) {
          const regular = items.find((item) => item.str?.includes("Regular"));
          const bold = items.find((item) => item.str?.includes("Bold"));
          assert.ok(regular && bold, "常规与粗体样例应可提取");
          assert.notEqual(
            regular.fontName,
            bold.fontName,
            "常规与粗体应使用不同字体资源",
          );
          result.checks.push({
            regular_font: regular.fontName,
            bold_font: bold.fontName,
          });
        }
        if (sample.chinese) {
          const canvasRequire = createRequire(
            require.resolve("pdfjs-dist/package.json"),
          );
          const { createCanvas } = canvasRequire("@napi-rs/canvas");
          const viewport = pdfPage.getViewport({ scale: 1.3 });
          const canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          await pdfPage.render({
            canvasContext: canvas.getContext("2d"),
            canvas,
            viewport,
          }).promise;
          await writeFile(
            join(evidence, `兼容样例-中文-${index}.png`),
            canvas.toBuffer("image/png"),
          );
        }
      }
      assert.ok(text.includes("12345.67"));
      assert.ok(
        text.includes(
          sample.chinese ? "住院费用兼容性验收" : "Export compatibility",
        ),
      );
      if (sample.chinese)
        assert.ok(text.includes("心内科") && text.includes("第二页"));
      result.checks.push({
        file: sample.name,
        extracted_text: text,
        pages: pdf.numPages,
      });
      await loadingTask.destroy();
    }
    result.checks.push({
      worker_generated: sample.name,
      bytes: (await stat(join(evidence, sample.name))).size,
    });
  }
  assert.deepEqual(result.errors, []);
  result.base_compatibility_passed = true;
  result.chinese_pdf_passed = hasChineseFonts;
  result.status = hasChineseFonts
    ? "兼容性通过，中文页面待人工目视核对"
    : "基础兼容性通过，中文 PDF 等待用户下载字体";
} catch (error) {
  result.errors.push(error.stack ?? String(error));
  result.status = "兼容性检查失败";
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((done) =>
    server ? server.httpServer.close(done) : done(),
  );
  await writeFile(
    join(evidence, "依赖兼容性验证.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      { status: result.status, checks: result.checks, errors: result.errors },
      null,
      2,
    ),
  );
}
