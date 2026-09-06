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
  relevanceScore: number;
  relevanceReason: string;
};
