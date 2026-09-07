export const MODELS = {
  moderation: "openai/gpt-oss-safeguard-20b",
  relevance: "@cf/openai/gpt-oss-20b",
  synthesis: "@cf/google/gemma-4-26b-a4b-it",
} as const;

export const RESULT_CACHE = {
  namespace: "fact-check-results",
  // 查核邏輯或回應契約改動時遞增；模型、提示與 LIMITS 另外自動納入快取鍵。
  version: "v3",
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

// 議題 #9：每小時模型費用上限，由 Durable Object 集中記帳；不納入結果快取鍵。
export const BUDGET = {
  // 預設每小時上限（美元）；部署可用 HOURLY_BUDGET_USD 變數覆蓋。
  hourlyUsd: 0.01,
  // 上游未回報 token 用量時的估算比例；中文約 1.5 個字元換算 1 token，偏向高估。
  charsPerToken: 1.5,
  timeoutMs: 2_000,
  // 依供應商公告的每百萬 token 牌價記帳（美元），不扣除 Workers AI 每日免費 neurons。
  pricingUsdPerMillion: {
    moderation: { input: 0.075, output: 0.3 },
    relevance: { input: 0.2, output: 0.3 },
    synthesis: { input: 0.1, output: 0.3 },
  },
  // 查核前預留的典型 token 數；查核後以實際用量結算差額。
  typicalTokens: {
    candidates: 8_000,
    evidence: 8_000,
    moderationOutput: 300,
    relevanceOutput: 1_500,
    synthesisOutput: 500,
  },
} as const;
