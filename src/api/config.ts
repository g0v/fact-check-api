export const MODELS = {
  moderation: "openai/gpt-oss-safeguard-20b",
  relevance: "@cf/openai/gpt-oss-20b",
  synthesis: "@cf/google/gemma-4-26b-a4b-it",
} as const;

export const RESULT_CACHE = {
  namespace: "fact-check-results",
  // 查核邏輯或回應契約改動時遞增；模型、提示與 LIMITS 另外自動納入快取鍵。
  version: "v2",
  ttlSeconds: 3600,
  timeoutMs: 1000,
} as const;

export const LIMITS = {
  text: 10_000,
  url: 2_048,
  requestBytes: 128_000,
  candidates: 15,
  candidateText: 3_000,
  relevant: 5,
  relevanceThreshold: 0.5, // 測試用0.5, 原為0.65
  evidenceText: 6_000,
  repliesPerArticle: 10,
  urlText: 12_000,
  urlBytes: 1_000_000,
  upstreamBytes: 2_000_000,
  redirects: 3,
  fetchTimeoutMs: 10_000,
  modelTimeoutMs: 60_000,
} as const;
