import DOMPurify from "dompurify";
import { safeDiagramSource } from "./markdown";

let queue: Promise<unknown> = Promise.resolve();
/** 浏览器解析 CSS 混色后转换为十六进制，适配 Mermaid 的颜色输入边界。 */
function diagramColor(value: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("颜色解析暂不可用");
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  return `#${Array.from(context.getImageData(0, 0, 1, 1).data)
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}
/** Mermaid 的全局配置按顺序使用，主题切换和多个消息不会互相覆盖配置。 */
function renderDiagram(source: string, print = false): Promise<string> {
  if (!safeDiagramSource(source))
    return Promise.reject(new Error("此流程图超出支持范围，已保留原始代码"));
  const task = queue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const id = `diagram-${crypto.randomUUID()}`;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 20000,
      maxEdges: 200,
      theme: "base",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: {
        useGradient: false,
        nodeShadow: false,
        darkMode: print ? false : root.classList.contains("dark"),
        primaryColor: print
          ? "#eaf0ec"
          : diagramColor(style.getPropertyValue("--app-primary-soft").trim()),
        primaryTextColor: print ? "#26382e" : style.getPropertyValue("--app-text").trim(),
        primaryBorderColor: print ? "#4f6e60" : style.getPropertyValue("--app-primary").trim(),
        lineColor: print ? "#596960" : style.getPropertyValue("--app-muted").trim(),
        fontFamily: "system-ui, sans-serif",
      },
    });
    try {
      const rendered = await mermaid.render(id, source);
      const clean = DOMPurify.sanitize(rendered.svg, {
        USE_PROFILES: { svg: true },
        ADD_TAGS: ["style"],
        FORBID_TAGS: ["foreignObject", "script", "image", "a", "use", "animate", "set"],
        FORBID_ATTR: ["href", "xlink:href"],
      });
      const container = document.createElement("div");
      container.innerHTML = clean;
      // 保留 SVG 内部箭头引用，外部资源及 CSS 导入不进入页面。
      const unsafeCss = (css: string) =>
        /@import|url\s*\(/i.test(css.replace(/url\(\s*["']?#[\w-]+["']?\s*\)/gi, ""));
      for (const element of container.querySelectorAll("[style]"))
        if (unsafeCss(element.getAttribute("style") ?? "")) element.removeAttribute("style");
      for (const element of container.querySelectorAll("style"))
        if (unsafeCss(element.textContent ?? "")) element.remove();
      return container.innerHTML;
    } finally {
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = task.catch(() => {});
  return task;
}
export { renderDiagram };
