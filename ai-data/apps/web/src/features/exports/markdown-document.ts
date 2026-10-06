import MarkdownIt from "markdown-it";
import type { MarkdownToken, DocumentBlock, DocumentRun } from "./export-types";
/** 与页面一致关闭原始 HTML 和外部图片，内联链接仅开放安全协议。 */
function inline(tokens: MarkdownToken[]): DocumentRun[] {
  const result: DocumentRun[] = [];
  let bold = 0,
    italic = 0,
    href: string | undefined;
  for (const token of tokens) {
    if (token.type === "strong_open") bold++;
    else if (token.type === "strong_close") bold--;
    else if (token.type === "em_open") italic++;
    else if (token.type === "em_close") italic--;
    else if (token.type === "link_open") {
      const value = String(token.attrGet("href") ?? "");
      href = /^(https?:|mailto:|#)/i.test(value) ? value : undefined;
    } else if (token.type === "link_close") href = undefined;
    else if (["text", "code_inline", "softbreak", "hardbreak", "image"].includes(token.type))
      result.push({
        text:
          token.type === "image"
            ? `[图片：${token.content || "未提供说明"}]`
            : token.type.endsWith("break")
              ? "\n"
              : token.content,
        ...(bold > 0 ? { bold: true } : {}),
        ...(italic > 0 ? { italic: true } : {}),
        ...(token.type === "code_inline" ? { code: true } : {}),
        ...(href ? { href } : {}),
      });
  }
  return result;
}
/** Markdown 词法节点转换为编辑器原生段落和表格，保持正文顺序。 */
function markdownDocument(source: string): DocumentBlock[] {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
  md.validateLink = (value) => /^(https?:|mailto:|#)/i.test(value);
  const tokens = md.parse(source, {}),
    result: DocumentBlock[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  let bullet: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open")
      lists.push({
        ordered: token.type === "ordered_list_open",
        next: Number(token.attrGet("start") ?? 1),
      });
    else if (token.type.endsWith("list_close")) lists.pop();
    else if (token.type === "list_item_open") {
      const list = lists.at(-1);
      bullet = list?.ordered ? `${list.next++}.` : "•";
    } else if (token.type === "list_item_close") bullet = undefined;
    else if (token.type === "heading_open") {
      result.push({
        kind: "heading",
        level: Number(token.tag.slice(1)),
        runs: inline(tokens[++i]?.children ?? []),
      });
    } else if (token.type === "inline") {
      result.push({
        kind: "paragraph",
        runs: inline(token.children ?? []),
        ...(bullet ? { bullet } : {}),
      });
      bullet = undefined;
    } else if (token.type === "fence" || token.type === "code_block")
      result.push(
        token.info.trim().toLowerCase() === "mermaid"
          ? { kind: "diagram", source: token.content }
          : { kind: "code", text: token.content },
      );
    else if (token.type === "hr") result.push({ kind: "paragraph", runs: [{ text: "────────" }] });
    else if (token.type === "table_open") {
      const rows: string[][] = [];
      let row: string[] = [];
      while (++i < tokens.length && tokens[i]!.type !== "table_close") {
        const cell = tokens[i]!;
        if (cell.type === "tr_open") row = [];
        else if (cell.type === "inline")
          row.push(
            inline(cell.children ?? [])
              .map((run) => run.text)
              .join(""),
          );
        else if (cell.type === "tr_close") rows.push(row);
      }
      if (rows.length) result.push({ kind: "table", rows });
    }
  }
  return result;
}
export { markdownDocument };
