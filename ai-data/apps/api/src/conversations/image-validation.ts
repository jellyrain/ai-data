import { imageAttachmentLimits } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";

/** 检查格式结构与声明的 MIME 一致，限制解码尺寸；编码内容由图像解码器最终校验。 */
function inspectImage(
  bytes: Buffer,
  declared: string,
): { mime_type: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number } {
  const invalid = () =>
    new ApplicationError("INVALID_INPUT", "图片格式或结构无效，请上传 JPG、PNG 或 WebP 图片");
  if (!bytes.length || bytes.length > imageAttachmentLimits.fileBytes)
    throw new ApplicationError("QUERY_LIMIT_EXCEEDED", "单张图片需大于 0 且不超过 10 MB");
  let width = 0,
    height = 0,
    mime: "image/png" | "image/jpeg" | "image/webp";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = "image/png";
    let offset = 8,
      ended = false,
      data = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset),
        kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + 12 + size > bytes.length) throw invalid();
      if (offset === 8) {
        if (kind !== "IHDR" || size !== 13) throw invalid();
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
      }
      if (kind === "acTL") throw new ApplicationError("INVALID_INPUT", "请上传静态图片");
      if (kind === "IDAT") data = true;
      offset += 12 + size;
      if (kind === "IEND") {
        ended = size === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended || !data) throw invalid();
  } else if (bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8) {
    mime = "image/jpeg";
    if (bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalid();
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (offset + 2 > bytes.length) throw invalid();
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) throw invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8) throw invalid();
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
      }
      offset += size;
    }
  } else if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    mime = "image/webp";
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
    let offset = 12,
      data = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString("ascii", offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4),
        start = offset + 8;
      if (start + size > bytes.length) throw invalid();
      if (kind === "VP8X" && size >= 10) {
        if (bytes[start]! & 2) throw new ApplicationError("INVALID_INPUT", "请上传静态图片");
        width = bytes.readUIntLE(start + 4, 3) + 1;
        height = bytes.readUIntLE(start + 7, 3) + 1;
      } else if (kind === "VP8 " && size >= 10) {
        if (!bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])))
          throw invalid();
        width = bytes.readUInt16LE(start + 6) & 0x3fff;
        height = bytes.readUInt16LE(start + 8) & 0x3fff;
        data = true;
      } else if (kind === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        data = true;
      }
      offset = start + size + (size % 2);
    }
    if (!data || offset !== bytes.length) throw invalid();
  } else throw invalid();
  if (mime !== declared) throw invalid();
  if (
    !width ||
    !height ||
    width > imageAttachmentLimits.dimension ||
    height > imageAttachmentLimits.dimension ||
    width * height > imageAttachmentLimits.pixels
  )
    throw new ApplicationError(
      "QUERY_LIMIT_EXCEEDED",
      "图片长宽不能超过 8192 像素，总像素不能超过 2000 万",
    );
  return { mime_type: mime, width, height };
}
export { inspectImage };
