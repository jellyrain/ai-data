import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
const root = dirname(fileURLToPath(import.meta.url)),
  require = createRequire(
    new URL("../../ai-data/apps/web/package.json", import.meta.url),
  );
const pdfjs = await import(
    pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
  ),
  canvasRequire = createRequire(require.resolve("pdfjs-dist/package.json")),
  { createCanvas } = canvasRequire("@napi-rs/canvas");
const result = [];
for (const name of [
  "Word实际排版",
  "Word宽表实际排版",
  "正式报表/门诊",
  "正式报表/住院",
  "正式报表/费用",
  "正式报表/已有费用会话",
]) {
  const task = pdfjs.getDocument({
      data: new Uint8Array(await readFile(join(root, `${name}.pdf`))),
    }),
    pdf = await task.promise;
  try {
    let characters = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index),
        viewport = page.getViewport({ scale: 1.25 }),
        canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
      const text = (await page.getTextContent()).items
        .map((item) => item.str ?? "")
        .join("");
      characters += text.length;
      await page.render({
        canvasContext: canvas.getContext("2d"),
        canvas,
        viewport,
      }).promise;
      await writeFile(
        join(root, `${name}-${index}.png`),
        canvas.toBuffer("image/png"),
      );
    }
    result.push({ name, pages: pdf.numPages, characters });
  } finally {
    await task.destroy();
  }
}
await writeFile(
  join(root, "业务PDF排版验证.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
