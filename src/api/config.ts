export const LIMITS = {
  text: 10_000,
  url: 2_048,
  requestBytes: 128_000,
  fetchTimeoutMs: 10_000,
} as const;

// 議題 #37：demo 是唯一免費入口，預設每個 IP 每 60 秒最多一次；可由 RATE_LIMIT_WINDOW_MS 覆寫。
export const RATE_LIMIT = {
  windowMs: 60_000,
} as const;
