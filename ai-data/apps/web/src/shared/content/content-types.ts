/** Markdown 代码原文保留供复制与按需渲染，索引只在当前消息内有效。 */
type CodeBlock = { code: string; language: string };
/** HTML 已清洗；代码块不包含任何可执行配置。 */
type RenderedMarkdown = { html: string; blocks: CodeBlock[] };
export type { CodeBlock, RenderedMarkdown };
