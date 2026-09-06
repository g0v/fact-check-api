import { LIMITS, MODELS } from "../config";
import { relevancePrompt } from "../prompts/relevance-filter";
import type { CofactsCandidate, RelevantCandidate, RelevanceResult } from "../types/cofacts";
import type { ApiBindings } from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import { withTimeout } from "../utils/http";
import { parseModelJson } from "../utils/model";
import { array, record, string, unitNumber } from "../utils/validation";

export async function filterRelevantCandidates(
  text: string,
  candidates: CofactsCandidate[],
  env: ApiBindings,
): Promise<{ selected: RelevantCandidate[]; results: RelevanceResult[] }> {
  if (!candidates.length) return { selected: [], results: [] };
  try {
    if (!env.AI) throw new Error("尚未設定 Workers AI。");
    const ai = env.AI;
    const output = await withTimeout(
      () =>
        ai.run(MODELS.relevance, {
          messages: [
            { role: "system", content: relevancePrompt },
            {
              role: "user",
              content: JSON.stringify({
                claim: text,
                candidates: candidates.map(({ articleId, text: candidateText }) => ({
                  articleId,
                  text: candidateText.slice(0, LIMITS.candidateText),
                })),
              }),
            },
          ],
          stream: false,
          temperature: 0,
          max_tokens: 6_144,
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    const candidateMap = new Map(candidates.map((candidate) => [candidate.articleId, candidate]));
    const seen = new Set<string>();
    const results = array(record(parseModelJson(output)).results).map((value): RelevanceResult => {
      const item = record(value);
      const articleId = string(item.article_id, 200);
      if (!candidateMap.has(articleId) || seen.has(articleId) || typeof item.relevant !== "boolean")
        throw new Error("初篩回應的文章 ID 或相關性格式不正確。");
      seen.add(articleId);
      return {
        articleId,
        relevant: item.relevant,
        relevance: unitNumber(item.relevance),
        reason: string(item.reason, 1_000),
      };
    });
    if (seen.size !== candidates.length) throw new Error("初篩回應遺漏文章。");
    const selected = results
      .filter((item) => item.relevant && item.relevance >= LIMITS.relevanceThreshold)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, LIMITS.relevant)
      .map((item) => ({
        ...candidateMap.get(item.articleId)!,
        relevanceScore: item.relevance,
        relevanceReason: item.reason,
      }));
    return { selected, results };
  } catch {
    throw upstreamError("relevance");
  }
}
