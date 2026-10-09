import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "../../../src/shared/identity/create-uuid";

afterEach(() => vi.unstubAllGlobals());

describe("浏览器 UUID 兼容", () => {
  it("支持原生 UUID 时保留 Crypto 接收者并直接返回结果", () => {
    const expected = "849f8c0c-5d10-4183-9cf7-858c1bbfc819";
    const source = {
      randomUUID: vi.fn(function (this: unknown) {
        expect(this).toBe(source);
        return expected;
      }),
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal("crypto", source);
    expect(createUuid()).toBe(expected);
    expect(source.getRandomValues).not.toHaveBeenCalled();
  });

  it.each([
    [0, "00000000-0000-4000-8000-000000000000"],
    [255, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ])("HTTP 环境使用加密随机字节 %i 生成标准 v4 UUID", (byte, expected) => {
    const source = {
      getRandomValues: vi.fn(function (this: unknown, values: Uint8Array) {
        expect(this).toBe(source);
        expect(values).toHaveLength(16);
        return values.fill(byte);
      }),
    };
    vi.stubGlobal("crypto", source);
    expect(createUuid()).toBe(expected);
    expect(source.getRandomValues).toHaveBeenCalledOnce();
  });
});
