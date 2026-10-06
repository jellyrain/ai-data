import { createRequire } from "node:module";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(directory, "../../ai-data/apps/web/package.json"),
);
const { chromium, expect } = require("@playwright/test");
const images = [];
for (const name of (await readdir(directory)).filter((name) =>
  name.endsWith(".png"),
)) {
  const data = await readFile(path.join(directory, name));
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  if (
    name.includes("手机")
      ? width !== 390 || height !== 844
      : width !== 1920 || height !== 1080
  )
    throw new Error(`尺寸错误：${name}`);
  images.push({ name, width, height });
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(directory, "审核.html")).href);
  for (const version of ["改前", "改后"]) {
    for (const section of await page.locator("section").all()) {
      await section.getByRole("button", { name: version, exact: true }).click();
      await expect(section.locator("img")).toHaveAttribute(
        "src",
        new RegExp(`${version}\\.png$`),
      );
      await section.locator("img").evaluate((image) => image.decode());
    }
  }
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
    environment: "Web production preview + isolated fixtures",
    images,
    switches: "passed",
    checked_links: links.length,
    errors,
  };
  await writeFile(
    path.join(directory, "截图检查.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({ images: images.length, switches: "passed", errors }),
  );
} finally {
  await browser.close();
}
