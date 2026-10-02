import { ApiError } from "./errors";

export async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError("INVALID_INPUT", "請求內容讀取逾時。", 400));
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  const read = async () => {
    let size = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) throw new ApiError("PAYLOAD_TOO_LARGE", "請求內容過大。", 413);
      text += decoder.decode(value, { stream: true });
    }
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_INPUT", "請求內容無法讀取。", 400);
  } finally {
    clearTimeout(timer);
    // 不等待來源完成取消；來源的 cancel() 可能永遠不回應，不能因此延遲錯誤回傳。
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
