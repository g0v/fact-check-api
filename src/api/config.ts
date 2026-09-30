export const LIMITS = {
  text: 10_000,
  url: 2_048,
  requestBytes: 128_000,
  fetchTimeoutMs: 10_000,
} as const;

// demo 端點的流量限制；付費 fact-check 端點由 x402 負責付款驗證。
export const RATE_LIMIT = {
  windowMs: 3_000,
} as const;
