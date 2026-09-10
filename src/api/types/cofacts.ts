export type CofactsCandidate = {
  articleId: string;
  text: string;
  searchScore: number | null;
};

export type RelevanceResult = {
  articleId: string;
  relevant: boolean;
  relevance: number;
  reason: string;
};

export type RelevantCandidate = CofactsCandidate & {
  // 初篩 fail-open 時不虛構模型分數或理由。
  relevanceScore?: number;
  relevanceReason?: string;
};
