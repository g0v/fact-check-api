export type FactCheckInput = { text: string; url?: string };
export type ModerationResult = {
  // skipped 只由程式在安全分類服務失敗時建構，不接受模型或快取回傳此值。
  decision: "allow" | "review" | "block" | "skipped";
  categories: string[];
  reason?: string;
};

export const verdicts = [
  "supported",
  "mostly_supported",
  "mixed",
  "mostly_refuted",
  "refuted",
  "insufficient_evidence",
] as const;
export type Verdict = (typeof verdicts)[number];
export type SynthesisResult = {
  factuality: number;
  confidence: number;
  verdict: Verdict;
  feedback: string;
};

export type Evidence = {
  source: "cofacts-human" | "cofacts-ai" | "provided-url";
  articleId?: string;
  articleText?: string;
  evidenceText: string;
  verdict?: "supports" | "refutes" | "mixed" | "opinion" | "unknown";
  classification?: string;
  referenceText?: string;
  sourceUrl?: string;
  sourceUrls?: string[];
  articleReferences?: string[];
  cofactsUrl?: string;
  retrievalScore?: number;
  relevanceScore?: number;
  positiveFeedback?: number;
  negativeFeedback?: number;
  reliability: "human-community" | "ai-generated" | "user-provided" | "allowlisted-institution";
};

export type UpstreamStage =
  | "moderation"
  | "cofacts-search"
  | "relevance"
  | "cofacts-evidence"
  | "url"
  | "synthesis";
export type Warning = { stage: UpstreamStage; code: "UPSTREAM_UNAVAILABLE"; article_id?: string };
export type RelatedCheck = {
  type: "cofacts_human" | "cofacts_ai";
  text: string;
  url: string;
  reference_url?: string;
  reference_urls?: string[];
  classification?: string;
  retrieval_score?: number;
  relevance_score?: number;
};
export type FactCheckResponse = FactCheckInput & {
  status: "completed" | "partial" | "blocked";
  moderation: ModerationResult;
  factuality: number | null;
  confidence: number | null;
  verdict: Verdict | null;
  related_checks: RelatedCheck[];
  feedback: string;
  meta: {
    request_id: string;
    cofacts_candidates: number;
    cofacts_relevant: number;
    cofacts_human_checks: number;
    cofacts_ai_checks: number;
    url_context_used: boolean;
    url_context_allowlisted: boolean;
    no_relevant_evidence: boolean;
    warnings: Warning[];
    cache?: {
      status: "hit" | "miss" | "bypass";
      cached_at?: string;
      expires_at?: string;
    };
  };
};

export type ModelMessage = { role: "system" | "user"; content: string };
// Durable Object namespace 的最小介面；避免依賴未安裝的 Cloudflare 型別套件。
export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
};
export type ApiBindings = {
  OPENROUTER_API_KEY?: string;
  // 議題 #9：每日 Workers AI 用量上限（neurons），未設定時採用 BUDGET.dailyNeurons。
  DAILY_NEURON_BUDGET?: string | number;
  USAGE_BUDGET?: DurableObjectNamespaceLike;
  AI?: {
    run(
      model: string,
      input: {
        messages: ModelMessage[];
        stream: false;
        temperature: number;
        max_tokens?: number;
        max_completion_tokens?: number;
        frequency_penalty?: number;
        chat_template_kwargs?: { enable_thinking?: boolean; clear_thinking?: boolean };
        response_format: { type: "json_object" };
      },
    ): Promise<unknown>;
  };
};
export type ApiEnv = {
  Bindings: ApiBindings;
  Variables: { requestId: string };
};
