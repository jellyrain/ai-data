import ExcelJS from "exceljs";
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import pdfMake from "pdfmake/build/pdfmake";
import roboto from "pdfmake/build/vfs_fonts";

import type { CompatibilityRequest } from "./compatibility-types";

/** 校验包接口使用真实二进制输出；样例仅用于安装后的前置兼容验证。 */
async function generate(request: CompatibilityRequest): Promise<ArrayBuffer> {
  if (request.format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("住院费用");
    sheet.addRows([
      ["科室", "金额", "编码", "备注", "有效"],
      ["心内科", 12345.67, "00123", "=1+1", true],
      ["外科", 0, "00000", "@文本", false],
    ]);
    return new Uint8Array(await workbook.xlsx.writeBuffer()).buffer;
  }
  if (request.format === "docx") {
    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph("住院费用兼容性验收"),
            new Table({
              rows: [
                new TableRow({
                  children: ["心内科", "12345.67"].map(
                    (text) => new TableCell({ children: [new Paragraph(text)] }),
                  ),
                }),
              ],
            }),
          ],
        },
      ],
    });
    return (await Packer.toBlob(document)).arrayBuffer();
  }

  if (request.chinese) {
    const fonts: Record<string, string> = {};
    for (const file of ["NotoSansSC-Regular.otf", "NotoSansSC-Bold.otf"]) {
      const response = await fetch(new URL(file, request.fontBase));
      if (!response.ok) throw new Error(`字体读取失败：${file} ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      }
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
  } else {
    pdfMake.addVirtualFileSystem(roboto);
  }
  const pdf = pdfMake.createPdf({
    defaultStyle: { font: request.chinese ? "NotoSansSC" : "Roboto" },
    content: [
      { text: request.chinese ? "住院费用兼容性验收" : "Export compatibility", bold: true },
      ...(request.chinese
        ? [
            { text: "正文 Regular 400：住院费用", fontSize: 20 },
            { text: "粗体 Bold 700：住院费用", fontSize: 20, bold: true },
          ]
        : []),
      { table: { body: [[request.chinese ? "心内科" : "Cardiology", "12345.67"]] } },
      { text: request.chinese ? "第二页：门诊、住院及费用" : "Second page", pageBreak: "before" },
    ],
  });
  return (await pdf.getBlob()).arrayBuffer();
}

self.onmessage = async (event: MessageEvent<CompatibilityRequest>) => {
  try {
    const buffer = await generate(event.data);
    self.postMessage({ buffer }, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
