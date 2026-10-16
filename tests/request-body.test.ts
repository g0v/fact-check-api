import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readLimitedText } from "../src/api/utils/http";

const encoder = new TextEncoder();

afterEach(() => {
  vi.useRealTimers();
});

describe("請求本文串流限制", () => {
  it("剛好達到 byte 上限時接受跨 chunk 的 UTF-8 字元", async () => {
    const text = "測試😀";
    const bytes = encoder.encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });

    expect(await readLimitedText(stream, bytes.byteLength, 1000)).toBe(text);
  });

  it("超過 byte 上限立即取消，不讀取後續 chunk，也不等待來源取消完成", async () => {
    let pulls = 0;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(encoder.encode("測"));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );

    await expect(readLimitedText(stream, 4, 1000)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("本文停止傳送時於總讀取期限取消，來源取消不回應也不延遲逾時", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{"));
      },
      cancel,
    });
    const result = readLimitedText(stream, 100, 10_000);
    const rejected = expect(result).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });

    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("串流讀取錯誤回輸入錯誤，不洩漏來源例外", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private stream diagnostic"));
      },
    });

    const result = readLimitedText(stream, 100, 1000);
    await expect(result).rejects.toMatchObject({
      code: "INVALID_INPUT",
      status: 400,
    });
    await expect(result).rejects.not.toThrow("private stream diagnostic");
    expect(stream.locked).toBe(false);
  });
});
