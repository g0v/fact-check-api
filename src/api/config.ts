export const MODELS = {
  moderation: "openai/gpt-oss-safeguard-20b",
  relevance: "@cf/openai/gpt-oss-20b",
  synthesis: "@cf/google/gemma-4-26b-a4b-it",
} as const;

export const RESULT_CACHE = {
  namespace: "fact-check-results",
  // 查核邏輯或回應契約改動時遞增；模型、提示與 LIMITS 另外自動納入快取鍵。
  version: "v6",
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
  relevanceThreshold: 0.65,
  evidenceText: 6_000,
  repliesPerArticle: 10,
  urlText: 12_000,
  urlBytes: 1_000_000,
  upstreamBytes: 2_000_000,
  redirects: 3,
  fetchTimeoutMs: 10_000,
  modelTimeoutMs: 60_000,
} as const;

// 議題 #9：每日 Workers AI 用量上限，由 Durable Object 集中記帳；不納入結果快取鍵。
export const BUDGET = {
  // 預設每日上限（neurons），等於 Workers AI 每日免費額度；部署可用 DAILY_NEURON_BUDGET 變數覆蓋。
  dailyNeurons: 10_000,
  // 上游未回報 token 用量時的估算比例；中文約 1.5 個字元換算 1 token，偏向高估。
  charsPerToken: 1.5,
  timeoutMs: 2_000,
  // Workers AI 公告的每百萬 token neurons 換算；安全分類走 OpenRouter，不計入 Workers AI 額度。
  neuronsPerMillionTokens: {
    relevance: { input: 18_182, output: 27_273 },
    synthesis: { input: 9_091, output: 27_273 },
  },
  // 查核前預留的典型 token 數；查核後以實際用量結算差額。
  typicalTokens: {
    candidates: 8_000,
    evidence: 8_000,
    relevanceOutput: 1_500,
    synthesisOutput: 500,
  },
} as const;

// 議題 #25：同 IP 流量限制，防止濫用。
export const RATE_LIMIT = {
  // 同一 IP 兩次查核的最短間隔；部署可用 RATE_LIMIT_WINDOW_MS 覆蓋。
  windowMs: 3_000,
} as const;
