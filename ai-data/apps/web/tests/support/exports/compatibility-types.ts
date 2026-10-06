/** 独立兼容性验收的文件格式及已核对字体入口。 */
type CompatibilityRequest = {
  format: "xlsx" | "docx" | "pdf";
  chinese: boolean;
  fontBase: string;
};

/** Worker 返回可转移成品或可定位错误，供浏览器验收读取。 */
type CompatibilityResponse = { buffer: ArrayBuffer } | { error: string };

export type { CompatibilityRequest, CompatibilityResponse };
