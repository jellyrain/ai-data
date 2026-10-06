import DOMPurify from "dompurify";

/** 按可见代码块加载已审核的语言，其余保持原文。 */
async function highlightCode(code: string, language: string): Promise<string | null> {
  if (code.length > 20000) return null;
  const names: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    sql: "sql",
    json: "json",
    javascript: "javascript",
    typescript: "typescript",
  };
  const name = names[language];
  if (!name) return null;
  const { default: highlighter } = await import("highlight.js/lib/core");
  if (!highlighter.getLanguage(name)) {
    const loaders = {
      sql: () => import("highlight.js/lib/languages/sql"),
      json: () => import("highlight.js/lib/languages/json"),
      javascript: () => import("highlight.js/lib/languages/javascript"),
      typescript: () => import("highlight.js/lib/languages/typescript"),
    };
    highlighter.registerLanguage(name, (await loaders[name as keyof typeof loaders]()).default);
  }
  return DOMPurify.sanitize(highlighter.highlight(code, { language: name }).value, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
  });
}
export { highlightCode };
