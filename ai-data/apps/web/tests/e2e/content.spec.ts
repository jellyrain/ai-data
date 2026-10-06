import { expect, test } from "@playwright/test";

test("实际浏览器中流程图可使用应用颜色并拒绝内容配置覆盖", async ({ page }) => {
  await page.goto("/tests/support/result-capacity.html");
  const result = await page.evaluate(async () => {
    const path = "/src/shared/content/diagram.ts";
    const module = await import(path);
    try {
      const results: boolean[] = [];
      for (const mode of ["light", "dark"])
        for (const palette of ["olive", "blue", "teal", "violet"]) {
          document.documentElement.classList.toggle("dark", mode === "dark");
          document.documentElement.dataset.palette = palette;
          const svg: string = await module.renderDiagram(
            "flowchart LR\n A[确认范围] --> B[读取授权数据]\n B --> C[核对结果]",
          );
          const host = document.createElement("div");
          document.body.append(host);
          host.innerHTML = svg;
          const rectangle = host.querySelector(".node rect");
          const label = host.querySelector(".node text");
          const fill = rectangle ? getComputedStyle(rectangle).fill : "missing";
          if (
            !rectangle ||
            !label ||
            fill === "rgb(0, 0, 0)" ||
            getComputedStyle(label).fill === fill
          )
            throw new Error(
              JSON.stringify({
                fill,
                label: label?.outerHTML,
                styles: host.querySelector("style")?.textContent?.slice(0, 300),
                snippet: svg.slice(0, 400),
              }),
            );
          results.push(svg.includes("<svg") && !svg.includes("<foreignObject"));
          host.remove();
        }
      let denied = false;
      try {
        await module.renderDiagram('%%{init: {securityLevel: "loose"}}%%\nflowchart LR\nA-->B');
      } catch {
        denied = true;
      }
      return { valid: results.length === 8 && results.every(Boolean) && denied, error: "" };
    } catch (error) {
      return { valid: false, error: String(error) };
    }
  });
  expect(result).toEqual({ valid: true, error: "" });
});

test("代码高亮、复制反馈、危险内容和流程图错误回退", async ({ page }) => {
  await page.goto("/tests/support/result-capacity.html");
  await page.evaluate(async () => {
    const vuePath = "/node_modules/.vite/deps/vue.js";
    const componentPath = "/src/shared/content/markdown-content.vue";
    const [{ createApp, h }, { default: Markdown }] = await Promise.all([
      import(vuePath),
      import(componentPath),
    ]);
    const host = document.createElement("section");
    document.body.append(host);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("拒绝访问");
        },
      },
    });
    createApp({
      render: () =>
        h(Markdown, {
          text:
            "<script>alert(1)</script>\n\n![外部图片](https://example.invalid/image.png)\n\n```sql\nSELECT visits FROM outpatient;\n```\n\n```mermaid\nflowchart LR\nA[\n```\n\n" +
            "可阅读长内容。".repeat(1300) +
            "末尾标记",
        }),
    }).mount(host);
  });
  await expect(page.locator(".markdown-content img, .markdown-content script")).toHaveCount(0);
  await expect(page.locator(".hljs-keyword").first()).toBeVisible();
  await page.getByRole("button", { name: "复制代码", exact: true }).first().click();
  await expect(page.getByText("复制失败，请选中代码手动复制")).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copied = text;
        },
      },
    }),
  );
  await page.getByRole("button", { name: "复制代码", exact: true }).first().click();
  await expect(page.getByText("代码已复制")).toBeVisible();
  expect(await page.evaluate(() => document.body.dataset.copied)).toBe(
    "SELECT visits FROM outpatient;\n",
  );
  await page.locator(".diagram-output").scrollIntoViewIfNeeded();
  await expect(page.locator(".diagram-output")).toContainText("流程图暂时无法绘制");
  await page.getByRole("button", { name: /展开全部内容/ }).click();
  await expect(page.getByText(/末尾标记$/)).toBeVisible();
});
