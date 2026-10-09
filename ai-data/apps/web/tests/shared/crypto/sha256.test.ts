import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../../src/shared/crypto/sha256";

afterEach(() => vi.unstubAllGlobals());

describe.each([true, false])("SHA-256 原生接口可用=%s", (native) => {
  beforeEach(() => vi.stubGlobal("crypto", native ? webcrypto : {}));

  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("标准向量 %s 的摘要一致", async (input, expected) => {
    expect(await sha256Hex(input)).toBe(expected);
  });

  it("UTF-8、补位边界和多数据块与服务端 SHA-256 一致", async () => {
    for (const input of [
      "科室明细🧪\u0000\ud800",
      ...[1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129].map((length) => "a".repeat(length)),
      "门诊人次：10,053。".repeat(10000),
    ]) {
      expect(await sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});

it("原生摘要执行失败时保留错误", async () => {
  const error = new Error("digest failed");
  vi.stubGlobal("crypto", { subtle: { digest: vi.fn().mockRejectedValue(error) } });
  await expect(sha256Hex("report")).rejects.toBe(error);
});
