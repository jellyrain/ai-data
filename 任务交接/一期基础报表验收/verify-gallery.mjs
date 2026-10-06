import { createRequire } from "node:module";
import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(directory, "../../ai-data/apps/web/package.json"),
);
const { chromium, expect } = require("@playwright/test");
const index = JSON.parse(
  await readFile(path.join(directory, "截图索引.json"), "utf8"),
);
for (const item of index.images) {
  const data = await readFile(path.join(directory, item.file));
  if (
    data.readUInt32BE(16) !== item.width ||
    data.readUInt32BE(20) !== item.height
  )
    throw new Error(`尺寸与索引不一致：${item.file}`);
  if (item.kind === "desktop" && (item.width !== 1920 || item.height !== 1080))
    throw new Error(`桌面截图未满足 16:9：${item.file}`);
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(directory, "审核.html")).href);
  await page.locator("img").evaluateAll(async (elements) => {
    await Promise.all(
      elements.map(async (image) => {
        image.loading = "eager";
        await image.decode();
      }),
    );
  });
  await expect(page.locator("article:visible")).toHaveCount(13);
  await page.getByRole("button", { name: "桌面 12", exact: true }).click();
  await expect(page.locator("article:visible")).toHaveCount(12);
  await page.getByRole("button", { name: "手机 1", exact: true }).click();
  await expect(page.locator("article:visible")).toHaveCount(1);
  await page.getByRole("button", { name: "全部 13", exact: true }).click();
  await expect(page.locator("article:visible")).toHaveCount(13);
  const links = await page
    .locator("a")
    .evaluateAll((elements) => elements.map((a) => a.href));
  for (const link of links) await stat(fileURLToPath(link));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  const result = {
    images: 13,
    desktop_16_9: 12,
    mobile: 1,
    links: links.length,
    filters: "passed",
    errors,
  };
  await writeFile(
    path.join(directory, "目录检查.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
