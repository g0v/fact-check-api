import { describe, expect, it } from "vite-plus/test";
import { parseInput } from "../src/api/schemas/fact-check";

describe("查核輸入 Unicode 字數上限", () => {
  it("接受 10,000 個非 BMP 字元，不以 UTF-16 code unit 誤拒", () => {
    const text = "😀".repeat(10_000);
    expect(parseInput({ text }).text).toBe(text);
  });

  it("先移除首尾空白，再判斷 10,000 字上限", () => {
    const text = "測".repeat(10_000);
    expect(parseInput({ text: ` \n${text}\t ` }).text).toBe(text);
  });

  it("超過 10,000 個 code point 時拒絕，包括非 BMP 字元", () => {
    expect(() => parseInput({ text: "😀".repeat(10_001) })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT", status: 400 }),
    );
  });

  it.each([" \n\t", 123, null])("拒絕空白或非字串 text：%s", (text) => {
    expect(() => parseInput({ text })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT", status: 400 }),
    );
  });
});
