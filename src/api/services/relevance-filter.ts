import { LIMITS, MODELS } from "../config";
import { relevancePrompt } from "../prompts/relevance-filter";
import type { CofactsCandidate, RelevantCandidate, RelevanceResult } from "../types/cofacts";
import type { ApiBindings, ModelMessage } from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import { withTimeout } from "../utils/http";
import type { Logger } from "../utils/logging";
import { parseModelJson } from "../utils/model";
import { measureUsage, type UsageRecorder } from "../utils/usage";
import { array, record, string, unitNumber } from "../utils/validation";

export async function filterRelevantCandidates(
  text: string,
  candidates: CofactsCandidate[],
  env: ApiBindings,
  log: Logger = () => {},
  usage: UsageRecorder = () => {},
): Promise<{ selected: RelevantCandidate[]; results: RelevanceResult[] }> {
  if (!candidates.length) return { selected: [], results: [] };
  try {
    if (!env.AI) throw new Error("尚未設定 Workers AI。");
    const ai = env.AI;
    const modelCandidates = candidates.map(({ articleId, text: candidateText }) => ({
      articleId,
      text: candidateText.slice(0, LIMITS.candidateText),
    }));
    log({
      event: "relevance_model_request",
      model: MODELS.relevance,
      candidate_count: modelCandidates.length,
      distinct_text_count: new Set(modelCandidates.map((item) => item.text)).size,
      article_ids: modelCandidates.map((item) => item.articleId),
      source_text_lengths: candidates.map((item) => item.text.length),
      sent_text_lengths: modelCandidates.map((item) => item.text.length),
    });
    const messages: ModelMessage[] = [
      { role: "system", content: relevancePrompt },
      {
        role: "user",
        content: JSON.stringify({
          claim: text,
          candidates: modelCandidates,
        }),
      },
    ];
    const output = await withTimeout(
      () =>
        ai.run(MODELS.relevance, {
          messages,
          stream: false,
          temperature: 0,
          max_tokens: LIMITS.relevanceMaxTokens,
          response_format: { type: "json_object" },
        }),
      LIMITS.modelTimeoutMs,
    );
    usage(measureUsage("relevance", MODELS.relevance, output, JSON.stringify(messages)));
    const candidateMap = new Map(candidates.map((candidate) => [candidate.articleId, candidate]));
    const modelItems = array(record(parseModelJson(output)).results).map(record);
    // 在 ID 對應、門檻與排序之前紀錄模型數值；未知 ID 與非數值不原樣寫入 log。
    log({
      event: "relevance_model_response",
      model: MODELS.relevance,
      result_count: modelItems.length,
      article_ids: modelItems.map((item) =>
        typeof item.article_id === "string" && candidateMap.has(item.article_id)
          ? item.article_id
          : "unknown",
      ),
      model_relevance_scores: modelItems.map((item) =>
        typeof item.relevance === "number" && Number.isFinite(item.relevance)
          ? item.relevance
          : null,
      ),
      model_relevant_count: modelItems.filter((item) => item.relevant === true).length,
    });
    const seen = new Set<string>();
    const results = modelItems.map((item): RelevanceResult => {
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
