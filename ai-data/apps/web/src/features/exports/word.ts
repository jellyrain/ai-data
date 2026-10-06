import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { DocumentRun, ExportJob } from "./export-types";
import { documentLayout, documentHeader, unresolvedText } from "./document-layout";
import { selectExportTables } from "./export-model";
function runs(values: DocumentRun[]) {
  return values.map((value) => {
    const run = new TextRun({
      text: value.text,
      bold: value.bold,
      italics: value.italic,
      font: value.code ? "Consolas" : "Noto Sans SC",
      ...(value.href ? { style: "Hyperlink" } : {}),
    });
    return value.href ? new ExternalHyperlink({ link: value.href, children: [run] }) : run;
  });
}
/** Word 使用原生段落、表格、超链接；图表以打印配色插图嵌入。 */
async function generateWord(job: ExportJob, stage: (value: string) => void): Promise<ArrayBuffer> {
  stage("正在编排 Word 正文和表格");
  const landscape = selectExportTables(job.document, job.tableIds).some(
    (table) => table.result.columns.length > 5,
  );
  const usableWidth = (landscape ? 16838 : 11906) - 1700;
  const children: (Paragraph | Table)[] = [];
  for (const block of documentLayout(job)) {
    if (block.kind === "heading")
      children.push(
        new Paragraph({
          children: runs(block.runs),
          heading:
            block.level === 1
              ? HeadingLevel.TITLE
              : block.level === 2
                ? HeadingLevel.HEADING_1
                : HeadingLevel.HEADING_2,
          keepNext: true,
          spacing: { before: 220, after: 120 },
        }),
      );
    else if (block.kind === "paragraph")
      children.push(
        new Paragraph({
          children: [
            ...(block.bullet ? [new TextRun(`${block.bullet} `)] : []),
            ...runs(block.runs),
          ],
          spacing: { after: 120 },
        }),
      );
    else if (block.kind === "table") {
      const columnWidth = Math.floor(usableWidth / Math.max(1, block.rows[0]?.length ?? 1));
      children.push(
        new Table({
          layout: TableLayoutType.FIXED,
          columnWidths: Array.from({ length: block.rows[0]?.length ?? 1 }, () => columnWidth),
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.rows.map(
            (row, index) =>
              new TableRow({
                tableHeader: index === 0,
                children: row.map(
                  (text) =>
                    new TableCell({
                      width: { size: columnWidth, type: WidthType.DXA },
                      children: [
                        new Paragraph({
                          children: [new TextRun({ text, bold: index === 0, size: 18 })],
                          spacing: { after: 80 },
                        }),
                      ],
                      ...(index === 0 ? { shading: { fill: "EAF0EC" } } : {}),
                    }),
                ),
              }),
          ),
        }),
      );
    } else if (block.kind === "image") {
      const scale = Math.min(620 / block.width, 500 / block.height, 1),
        width = block.width * scale,
        height = block.height * scale;
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: "png",
              data: Uint8Array.from(atob(block.data.split(",")[1]!), (c) => c.charCodeAt(0)),
              transformation: { width, height },
            }),
          ],
        }),
        new Paragraph({
          children: [new TextRun({ text: block.caption, italics: true, size: 18 })],
        }),
      );
    } else
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: block.kind === "code" ? block.text : unresolvedText(block),
              font: block.kind === "code" ? "Consolas" : "Noto Sans SC",
              size: 18,
            }),
          ],
          spacing: { after: 120 },
        }),
      );
  }
  const document = new Document({
    title: job.document.title,
    creator: "AI Data",
    styles: {
      default: {
        heading1: { run: { color: "26382E", bold: true } },
        heading2: { run: { color: "26382E", bold: true } },
        document: {
          run: { font: "Noto Sans SC", size: 22 },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: { top: 850, bottom: 850, left: 850, right: 850 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: documentHeader(job.document.title),
                    size: 16,
                    color: "66736B",
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES] }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  stage("正在压缩 Word 文件");
  return (await Packer.toBlob(document)).arrayBuffer();
}
export { generateWord };
