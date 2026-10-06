import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { CodeBlock, RenderedMarkdown } from "./content-types";

/** 只开放有界流程图；渲染配置完全由应用持有。 */
function safeDiagramSource(source: string): boolean {
  return (
    source.length <= 20000 &&
    /^\s*(?:flowchart|graph)\s+(?:LR|RL|TB|TD|BT)\b/.test(source) &&
    !/%%\{|^\s*---|\b(?:click|classDef|linkStyle|style)\b|@\{|<\s*[a-z!/]|\b(?:href|javascript|url)\s*[:(]/im.test(
      source,
    ) &&
    (source.match(/-->|---|==>|-\.->|--[ox]|<--/g)?.length ?? 0) <= 200
  );
}
/** 原始 HTML 关闭，外部图片仅显示替代文本，清洗后的链接仅接受安全协议。 */
function renderMarkdown(text: string, streaming = false): RenderedMarkdown {
  const blocks: CodeBlock[] = [];
  const markdown = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: true,
  });
  markdown.validateLink = (value) => /^(?:https?:|mailto:|#)/i.test(value);
  markdown.renderer.rules.image = (tokens, index) =>
    `<span class="content-image-note">[图片：${markdown.utils.escapeHtml(tokens[index]?.content || "未提供说明")}]</span>`;
  const originalLink = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    tokens[index]!.attrSet("rel", "noopener noreferrer");
    tokens[index]!.attrSet("target", "_blank");
    return originalLink
      ? originalLink(tokens, index, options, environment, renderer)
      : renderer.renderToken(tokens, index, options);
  };
  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]!;
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    // 生成中的代码围栏先显示文本；闭合后才启动高亮与流程图，避免反复报错和布局跳动。
    const lastLine = token.map ? (text.split("\n")[token.map[1] - 1] ?? "") : "";
    if (
      streaming &&
      !new RegExp(`^\\s{0,3}${token.markup[0]}{${token.markup.length},}\\s*$`).test(lastLine)
    )
      return `<pre><code>${markdown.utils.escapeHtml(token.content)}</code></pre>`;
    const id = blocks.push({ language, code: token.content }) - 1;
    return `<section class="code-block"><div class="code-toolbar"><span>${markdown.utils.escapeHtml(language || "代码")}</span><button type="button" data-copy-index="${id}">复制代码</button></div><pre><code data-code-index="${id}">${markdown.utils.escapeHtml(token.content)}</code></pre>${language === "mermaid" ? `<div class="diagram-output" data-diagram-index="${id}" aria-label="流程图"><p>流程图准备中…</p></div>` : ""}</section>`;
  };
  const html = DOMPurify.sanitize(markdown.render(text), {
    ALLOWED_TAGS: [
      "p",
      "br",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "strong",
      "em",
      "s",
      "blockquote",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "pre",
      "code",
      "section",
      "div",
      "span",
      "button",
    ],
    ALLOWED_ATTR: [
      "href",
      "title",
      "target",
      "rel",
      "class",
      "type",
      "start",
      "aria-label",
      "data-copy-index",
      "data-code-index",
      "data-diagram-index",
    ],
    ALLOW_DATA_ATTR: false,
  });
  return { html, blocks };
}
export { renderMarkdown, safeDiagramSource };
