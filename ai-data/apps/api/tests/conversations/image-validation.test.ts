import { describe, expect, it } from "vitest";
import { inspectImage } from "../../src/conversations/image-validation";
import { testImage } from "../support/test-image";

describe("上传图片边界", () => {
  it("读取 PNG 实际格式和尺寸", () => {
    expect(inspectImage(testImage(80, 40), "image/png")).toEqual({
      mime_type: "image/png",
      width: 80,
      height: 40,
    });
  });
  it("拒绝伪造格式、空文件、损坏结构和超过尺寸或容量的图片", () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("<svg/>"),
      testImage().subarray(0, 28),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ])
      expect(() => inspectImage(bytes, "image/png")).toThrow();
    expect(() => inspectImage(testImage(), "image/jpeg")).toThrow();
    expect(() => inspectImage(testImage(1, 8193), "image/png")).toThrow();
  });
});
