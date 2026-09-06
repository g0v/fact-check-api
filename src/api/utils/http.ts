import { LIMITS } from "../config";

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const httpErrorMessages = {
  timeout: "服務回應逾時。",
  network_error: "上游請求無法送出，請檢查連線與請求參數。",
  http_error: "上游服務回應失敗。",
  response_read_error: "無法讀取上游回應。",
  response_too_large: "回應內容超過大小限制。",
  invalid_response_json: "上游回應不是有效 JSON。",
} as const;

export class HttpError extends Error {
  constructor(public readonly reason: keyof typeof httpErrorMessages) {
    super(httpErrorMessages[reason]);
    this.name = "HttpError";
  }
}

export async function withTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HttpError("timeout"));
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
      if (size > maxBytes) throw new HttpError("response_too_large");
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
  onResponse?: (status: number) => void,
): Promise<unknown> {
  return withTimeout(async (signal) => {
    let response: Response;
    try {
      // Workers 不支援 redirect: "error"；改用 manual，並由下方拒絕非成功狀態。
      response = await fetcher(url, { ...init, signal, redirect: "manual" });
    } catch {
      throw new HttpError("network_error");
    }
    // 已逾時的請求不再發出回應紀錄，也不繼續讀取本文。
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError("timeout");
    }
    onResponse?.(response.status);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError("http_error");
    }
    let body: string;
    try {
      body = await readLimitedText(response.body, LIMITS.upstreamBytes, signal);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("response_read_error");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new HttpError("invalid_response_json");
    }
  }, timeoutMs);
}
