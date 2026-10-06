import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第7步验收/", import.meta.url));
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();
}
async function report(page: Page, id = "report-01") {
  await login(page);
  await page.goto(`/reports/${id}`);
  await expect(page.getByRole("heading", { name: "门诊人次", exact: true })).toBeVisible();
}
async function generate(page: Page, format: string) {
  await page
    .locator(".export-format-options .el-radio")
    .filter({ hasText: new RegExp(`^${format}`) })
    .click();
  await page.getByRole("button", { name: "生成文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载文件", exact: true })).toBeVisible({
    timeout: 60000,
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  return downloading;
}
test("分享搜索分页、保存与重新读取，保留当前结果", async ({ page }) => {
  await report(page);
  const before = await page.locator(".report-result-heading").innerText();
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(20);
  await page
    .locator("label.el-checkbox")
    .filter({ has: page.getByRole("checkbox", { name: "同名成员 analyst1", exact: true }) })
    .click();
  await page.getByRole("button", { name: "加载更多成员", exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(40);
  await page.getByPlaceholder("搜索姓名或账号").fill("analyst45");
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await page
    .locator("label.el-checkbox")
    .filter({ has: page.getByRole("checkbox", { name: "成员 45 analyst45", exact: true }) })
    .click();
  await page.getByRole("button", { name: "保存分享设置", exact: true }).click();
  await expect(page.getByText("分享设置已保存", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/分享设置.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.locator(".sharing-content")).not.toBeVisible();
  expect(await page.locator(".report-result-heading").innerText()).toBe(before);
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(page.getByText("已选成员（2）", { exact: true })).toBeVisible();
});
test("生产 Worker 下载三种格式，验证单元格、Word 结构、PDF 中文和图片", async ({ page }) => {
  test.setTimeout(150000);
  await mkdir(evidence, { recursive: true });
  const errors: string[] = [],
    requested: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requested.push(request.url()));
  await report(page);
  expect(requested.some((url) => /\/fonts\/|\/assets\/(pdf|spreadsheet|word)-/.test(url))).toBe(
    false,
  );
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("已选 2 张表 · 12 行", { exact: true })).toBeVisible();
  for (const [format, extension] of [
    ["Excel", "xlsx"],
    ["Word", "docx"],
    ["PDF", "pdf"],
  ]) {
    const download = await generate(page, format!);
    const path = `${evidence}/业务报表.${extension}`;
    await download.saveAs(path);
    const bytes = await readFile(path);
    if (extension === "xlsx") {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Uint8Array.from(bytes).buffer);
      expect(book.worksheets).toHaveLength(3);
      const sheet = book.worksheets.find((s) => s.name === "门诊人次")!;
      expect(sheet.rowCount).toBe(7);
      expect(sheet.getCell("A2").value).toBe("内科");
      expect(sheet.getCell("B2").value).toBe(40);
    }
    if (extension === "docx") {
      const zip = unzipSync(bytes);
      expect(strFromU8(zip["word/document.xml"]!)).toContain("<w:tbl>");
      expect(strFromU8(zip["word/document.xml"]!)).toContain("6 / 6");
      expect(Object.keys(zip).some((key) => key.startsWith("word/media/"))).toBe(true);
    }
    if (extension === "pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"),
        task = pdfjs.getDocument({ data: new Uint8Array(bytes) }),
        pdf = await task.promise;
      try {
        const texts: string[] = [];
        for (let index = 1; index <= pdf.numPages; index++) {
          const p = await pdf.getPage(index);
          texts.push(
            (await p.getTextContent()).items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" "),
          );
        }
        expect(texts.join(" ")).toContain("门诊与费用月报");
        expect(texts.join(" ")).toContain("内科");
        expect(pdf.numPages).toBeGreaterThan(1);
        const require = createRequire(import.meta.url),
          canvasRequire = createRequire(require.resolve("pdfjs-dist/package.json")),
          { createCanvas } = canvasRequire("@napi-rs/canvas");
        for (const number of [1, pdf.numPages]) {
          const p = await pdf.getPage(number),
            viewport = p.getViewport({ scale: 1.5 }),
            canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await p.render({ canvasContext: canvas.getContext("2d"), canvas, viewport }).promise;
          await writeFile(`${evidence}/业务PDF-${number}.png`, canvas.toBuffer("image/png"));
        }
      } finally {
        await task.destroy();
      }
    }
  }
  await page.screenshot({ path: `${evidence}/导出文件.png`, fullPage: true });
  expect(errors).toEqual([]);
});
test("下载前授权拒绝销毁成品，页面不会下载旧缓冲", async ({ page }) => {
  await report(page);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("已选 2 张表 · 12 行", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载文件", exact: true })).toBeVisible();
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await page.route("**/report-executions/*/export-content", (route) =>
    route.fulfill({ status: 403, json: { code: "UNAUTHORIZED", message: "数据权限已撤回" } }),
  );
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  await expect(page.getByText("数据权限已撤回", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载文件", exact: true })).toHaveCount(0);
  expect(downloaded).toBe(false);
});
