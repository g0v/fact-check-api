export type FactCheckInput = { text: string; url?: string };
export type ModerationResult = {
  decision: "allow" | "review" | "block";
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
  reliability: "human-community" | "ai-generated" | "user-provided";
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
    warnings: Warning[];
  };
};

export type ModelMessage = { role: "system" | "user"; content: string };
export type ApiBindings = {
  OPENROUTER_API_KEY?: string;
  AI?: {
    run(
      model: string,
      input: {
        messages: ModelMessage[];
        stream: false;
        temperature: number;
        max_tokens?: number;
        max_completion_tokens?: number;
        response_format: { type: "json_object" };
      },
    ): Promise<unknown>;
  };
};
export type ApiEnv = {
  Bindings: ApiBindings;
  Variables: { requestId: string };
};
