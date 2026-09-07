import { LIMITS } from "../config";
import type { CofactsCandidate, RelevantCandidate } from "../types/cofacts";
import type {
  ApiBindings,
  Evidence,
  FactCheckInput,
  FactCheckResponse,
  ModerationResult,
  RelatedCheck,
  UpstreamStage,
  Warning,
} from "../types/fact-check";
import { ApiError, upstreamError } from "../utils/errors";
import type { Fetcher } from "../utils/http";
import { createStageRunner, type Logger } from "../utils/logging";
import type { UsageRecorder } from "../utils/usage";
import { getCofactsEvidence } from "./cofacts-evidence";
import { searchCofactsCandidates } from "./cofacts-search";
import { moderate } from "./moderation";
import { filterRelevantCandidates } from "./relevance-filter";
import { synthesize } from "./synthesizer";
import { fetchUrlContext } from "./url-context";

export async function factCheck(
  input: FactCheckInput,
  env: ApiBindings,
  options: { requestId?: string; fetcher?: Fetcher; log?: Logger; usage?: UsageRecorder } = {},
): Promise<FactCheckResponse> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const fetcher = options.fetcher ?? fetch;
  const usage: UsageRecorder = options.usage ?? (() => undefined);
  const log: Logger = options.log ?? ((event) => console.info(JSON.stringify(event)));
  const stage = createStageRunner(requestId, log);
  const warnings: Warning[] = [];
  const warn = (name: UpstreamStage, articleId?: string) => {
    warnings.push({
      stage: name,
      code: "UPSTREAM_UNAVAILABLE",
      ...(articleId ? { article_id: articleId } : {}),
    });
  };
  const meta: FactCheckResponse["meta"] = {
    request_id: requestId,
    cofacts_candidates: 0,
    cofacts_relevant: 0,
    cofacts_human_checks: 0,
    cofacts_ai_checks: 0,
    url_context_used: false,
    url_context_allowlisted: false,
    no_relevant_evidence: false,
    warnings,
  };
  log({
    event: "request",
    request_id: requestId,
    text_length: [...input.text].length,
    has_url: Boolean(input.url),
    openrouter_api_key_present: env.OPENROUTER_API_KEY != null,
  });
  let moderation: ModerationResult;
  try {
    moderation = await stage("moderation", () =>
      moderate(
        input.text,
        env,
        fetcher,
        (event) => log({ ...event, request_id: requestId }),
        usage,
      ),
    );
  } catch (error) {
    // Issue #12：OpenRouter 不穩定時跳過安全分類、標記警告並繼續查核；設定錯誤仍回 502。
    if (error instanceof ApiError && error.configError) throw error;
    warn("moderation");
    moderation = {
      decision: "skipped",
      categories: [],
      reason: "安全分類服務暫時無法使用，本次未執行安全檢查。",
    };
  }
  log({ event: "moderation", request_id: requestId, decision: moderation.decision });
  if (moderation.decision === "block") {
    return {
      ...input,
      status: "blocked",
      moderation,
      factuality: null,
      confidence: null,
      verdict: null,
      related_checks: [],
      feedback: "此內容未通過安全檢查，已停止查核。",
      meta,
    };
  }

  const [searchResult, urlResult] = await Promise.allSettled([
    stage("cofacts-search", () => searchCofactsCandidates(input.text, fetcher)),
    input.url ? stage("url", () => fetchUrlContext(input.url!, fetcher)) : Promise.resolve(null),
  ]);
  const urlContext = urlResult.status === "fulfilled" ? urlResult.value : null;
  if (urlResult.status === "rejected") warn("url");
  meta.url_context_used = Boolean(urlContext);
  meta.url_context_allowlisted = urlContext?.reliability === "allowlisted-institution";
  let candidates: CofactsCandidate[] = [];
  if (searchResult.status === "fulfilled") candidates = searchResult.value;
  else throw upstreamError("cofacts-search");
  meta.cofacts_candidates = candidates.length;
  log({
    event: "candidates",
    request_id: requestId,
    count: candidates.length,
    article_ids: candidates.map((item) => item.articleId),
    retrieval_scores: candidates.map((item) => item.searchScore),
  });
  let selected: RelevantCandidate[] = [];
  if (candidates.length) {
    try {
      const relevance = await stage("relevance", () =>
        filterRelevantCandidates(
          input.text,
          candidates,
          env,
          (event) => log({ ...event, request_id: requestId }),
          usage,
        ),
      );
      selected = relevance.selected;
      log({
        event: "relevance",
        request_id: requestId,
        candidate_count: candidates.length,
        article_ids: relevance.results.map((item) => item.articleId),
        relevant_flags: relevance.results.map((item) => item.relevant),
        relevance_scores: relevance.results.map((item) => item.relevance),
        relevance_threshold: LIMITS.relevanceThreshold,
        selection_limit: LIMITS.relevant,
        selected_count: selected.length,
        selected_article_ids: selected.map((item) => item.articleId),
      });
    } catch {
      throw upstreamError("relevance");
    }
  }
  meta.cofacts_relevant = selected.length;
  const details = selected.length
    ? await stage("cofacts-evidence", () => getCofactsEvidence(selected, fetcher))
    : { evidence: [], failedArticleIds: [] };
  details.failedArticleIds.forEach((id) => warn("cofacts-evidence", id));
  const evidence: Evidence[] = [...details.evidence, ...(urlContext ? [urlContext] : [])];
  meta.cofacts_human_checks = details.evidence.filter(
    (item) => item.source === "cofacts-human",
  ).length;
  meta.cofacts_ai_checks = details.evidence.filter((item) => item.source === "cofacts-ai").length;
  // Issue #10、#24：一般 url-only 仍走常識判斷；白名單機構網址
  // 可在 Cofacts 無資料時作為參考證據。
  meta.no_relevant_evidence =
    details.evidence.length === 0 && urlContext?.reliability !== "allowlisted-institution";
  log({
    event: "evidence",
    request_id: requestId,
    human_count: meta.cofacts_human_checks,
    ai_count: meta.cofacts_ai_checks,
    has_url_context: Boolean(urlContext),
    url_context_allowlisted: meta.url_context_allowlisted,
    no_relevant_evidence: meta.no_relevant_evidence,
  });
  const result = await stage("synthesis", () =>
    synthesize(input, moderation, evidence, env, usage, (event) =>
      log({ ...event, request_id: requestId }),
    ),
  );
  const relatedChecks: RelatedCheck[] = details.evidence.map((item) => ({
    type: item.source === "cofacts-human" ? "cofacts_human" : "cofacts_ai",
    text: item.evidenceText,
    url: item.cofactsUrl!,
    reference_url: item.sourceUrl,
    reference_urls: item.sourceUrls,
    classification: item.classification,
    retrieval_score: item.retrievalScore,
    relevance_score: item.relevanceScore,
  }));
  const status = warnings.length ? "partial" : "completed";
  log({
    event: "result",
    request_id: requestId,
    status,
    verdict: result.verdict,
    factuality: result.factuality,
    confidence: result.confidence,
  });
  return { ...input, status, moderation, ...result, related_checks: relatedChecks, meta };
}
