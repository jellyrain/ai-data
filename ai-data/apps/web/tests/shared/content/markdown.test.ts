import { describe, expect, it } from "vitest";
import { renderMarkdown, safeDiagramSource } from "../../../src/shared/content/markdown";

describe("AI 内容的安全渲染", () => {
  it("流式代码围栏未闭合时保留文本，闭合后才交给高亮和流程图", () => {
    const content = "```mermaid\nflowchart LR\n A --> B\n";
    expect(renderMarkdown(content, true).blocks).toEqual([]);
    expect(renderMarkdown(content, true).html).toContain("flowchart LR");
    expect(renderMarkdown(content + "```", true).blocks).toHaveLength(1);
    expect(renderMarkdown(content).blocks).toHaveLength(1);
  });
  it("段落、列表和表格保留语义，原始 HTML 与危险链接不能执行", () => {
    const result = renderMarkdown(
      "## 结论\n\n- 人次 20\n\n|科室|人次|\n|---|---|\n|门诊|20|\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))",
    );
    expect(result.html).toContain("<h2>结论</h2>");
    expect(result.html).toContain("<table>");
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain('href="javascript:');
  });
  it("外部图片不自动请求，链接禁止泄漏 opener 和 referrer", () => {
    const result = renderMarkdown(
      "![私有数据](https://remote.example/image)\n\n[来源](https://example.com)",
    );
    const element = document.createElement("div");
    element.innerHTML = result.html;
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("a")?.getAttribute("rel")).toContain("noreferrer");
    expect(element.querySelector("a")?.getAttribute("rel")).toContain("noopener");
  });
  it("代码保留原文用于复制，危险标签仍是普通代码", () => {
    const result = renderMarkdown(
      "```sql\nSELECT '<img onerror=alert(1)>';\n```\n\n```mermaid\nflowchart LR\n A --> B\n```",
    );
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.code).toContain("<img onerror=alert(1)>");
    expect(result.blocks[1]?.language).toBe("mermaid");
    expect(result.html).not.toContain("<img");
  });
  it("流程图只接受有界 flowchart，配置覆盖、链接和非流程图回退代码", () => {
    expect(safeDiagramSource("flowchart LR\n A --> B")).toBe(true);
    for (const value of [
      '%%{init: {securityLevel: "loose"}}%%\nflowchart LR\nA-->B',
      "---\nconfig: {}\n---\nflowchart LR\nA-->B",
      'flowchart LR\nclick A "https://example.com"',
      "sequenceDiagram\nA->>B: x",
      `flowchart LR\n${"A-->B;".repeat(201)}`,
      `flowchart LR\n${"x".repeat(20001)}`,
    ])
      expect(safeDiagramSource(value)).toBe(false);
  });
});
