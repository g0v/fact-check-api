import { LIMITS } from "../config";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function withTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("服務回應逾時。"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([action(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("回應內容超過大小限制。");
      text += decoder.decode(value, { stream: true });
    }
    signal?.throwIfAborted();
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function fetchJson(
  fetcher: Fetcher,
  url: string | URL,
  init: RequestInit,
  timeoutMs: number = LIMITS.fetchTimeoutMs,
): Promise<unknown> {
  return withTimeout(async (signal) => {
    const response = await fetcher(url, { ...init, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("上游服務回應失敗。");
    }
    return JSON.parse(await readLimitedText(response.body, LIMITS.upstreamBytes, signal));
  }, timeoutMs);
}
