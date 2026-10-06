import pdfMake from "pdfmake/build/pdfmake";
import type { Content, ContentText } from "pdfmake/interfaces";
import type { DocumentRun, ExportJob } from "./export-types";
import { documentLayout, documentHeader, unresolvedText } from "./document-layout";
function runs(values: DocumentRun[]): ContentText[] {
  return values.map((run) => ({
    text: run.text,
    bold: run.bold,
    italics: run.italic,
    ...(run.href ? { link: run.href, color: "215E77" } : {}),
  }));
}
/** 静态 OFL 字体只在 PDF Worker 内加载，并嵌入成品。 */
async function generatePdf(job: ExportJob, stage: (value: string) => void): Promise<ArrayBuffer> {
  stage("正在读取中文字体");
  const fonts: Record<string, string> = {};
  for (const file of ["NotoSansSC-Regular.otf", "NotoSansSC-Bold.otf"]) {
    const response = await fetch(new URL(file, job.fontBase));
    if (!response.ok) throw new Error(`字体读取失败：${file}，请检查部署字体资源`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    fonts[file] = btoa(binary);
  }
  pdfMake.addVirtualFileSystem(fonts);
  pdfMake.addFonts({
    NotoSansSC: {
      normal: "NotoSansSC-Regular.otf",
      bold: "NotoSansSC-Bold.otf",
      italics: "NotoSansSC-Regular.otf",
      bolditalics: "NotoSansSC-Bold.otf",
    },
  });
  stage("正在编排 PDF 分页");
  const content: Content[] = documentLayout(job).flatMap((block): Content[] => {
    if (block.kind === "heading")
      return [
        {
          text: runs(block.runs),
          fontSize: block.level === 1 ? 22 : block.level === 2 ? 15 : 12,
          bold: true,
          margin: [0, 14, 0, 8],
        },
      ];
    if (block.kind === "paragraph")
      return [
        {
          text: [...(block.bullet ? [{ text: `${block.bullet} ` }] : []), ...runs(block.runs)],
          margin: [0, 0, 0, 8],
        },
      ];
    if (block.kind === "table")
      return [
        {
          table: {
            headerRows: 1,
            widths: Array.from({ length: Math.max(1, block.rows[0]?.length ?? 1) }, () => "*"),
            body: block.rows.map((row, i) =>
              row.map((text) => ({
                text,
                bold: i === 0,
                fillColor: i === 0 ? "#EAF0EC" : undefined,
                fontSize: 9,
                margin: [2, 3, 2, 3],
              })),
            ),
          },
          layout: "lightHorizontalLines",
          margin: [0, 0, 0, 12],
        },
      ];
    if (block.kind === "image")
      return [
        { image: block.data, fit: [510, 370], margin: [0, 8, 0, 5] },
        { text: block.caption, fontSize: 9, color: "#596960", margin: [0, 0, 0, 12] },
      ];
    return [
      {
        text: block.kind === "code" ? block.text : unresolvedText(block),
        fontSize: 9,
        margin: [0, 4, 0, 10],
      },
    ];
  });
  const pdf = pdfMake.createPdf({
    pageSize: "A4",
    pageMargins: [40, 48, 40, 44],
    defaultStyle: { font: "NotoSansSC", fontSize: 10, lineHeight: 1.25, color: "#26382E" },
    info: { title: job.document.title, author: "AI Data" },
    header: {
      text: documentHeader(job.document.title),
      fontSize: 8,
      color: "#596960",
      margin: [40, 20, 40, 0],
    },
    footer: (page, count) => ({
      text: `${page} / ${count}`,
      alignment: "center",
      fontSize: 9,
      margin: [0, 12, 0, 0],
    }),
    content,
  });
  stage("正在嵌入字体并生成 PDF");
  return (await pdf.getBlob()).arrayBuffer();
}
export { generatePdf };
