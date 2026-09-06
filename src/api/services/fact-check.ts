import type { CofactsCandidate, RelevantCandidate } from "../types/cofacts";
import type {
  ApiBindings,
  Evidence,
  FactCheckInput,
  FactCheckResponse,
  RelatedCheck,
  UpstreamStage,
  Warning,
} from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import type { Fetcher } from "../utils/http";
import { createStageRunner, type Logger } from "../utils/logging";
import { getCofactsEvidence } from "./cofacts-evidence";
import { searchCofactsCandidates } from "./cofacts-search";
import { moderate } from "./moderation";
import { filterRelevantCandidates } from "./relevance-filter";
import { synthesize } from "./synthesizer";
import { fetchUrlContext } from "./url-context";

export async function factCheck(
  input: FactCheckInput,
  env: ApiBindings,
  options: { requestId?: string; fetcher?: Fetcher; log?: Logger } = {},
): Promise<FactCheckResponse> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const fetcher = options.fetcher ?? fetch;
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
    warnings,
  };
  log({
    event: "request",
    request_id: requestId,
    text_length: [...input.text].length,
    has_url: Boolean(input.url),
  });
  const moderation = await stage("moderation", () => moderate(input.text, env, fetcher));
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
  let candidates: CofactsCandidate[] = [];
  if (searchResult.status === "fulfilled") candidates = searchResult.value;
  else {
    if (!urlContext) throw upstreamError("cofacts-search");
    warn("cofacts-search");
  }
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
        filterRelevantCandidates(input.text, candidates, env),
      );
      selected = relevance.selected;
      log({
        event: "relevance",
        request_id: requestId,
        article_ids: relevance.results.map((item) => item.articleId),
        relevance_scores: relevance.results.map((item) => item.relevance),
        selected_article_ids: selected.map((item) => item.articleId),
      });
    } catch {
      if (!urlContext) throw upstreamError("relevance");
      warn("relevance");
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
  log({
    event: "evidence",
    request_id: requestId,
    human_count: meta.cofacts_human_checks,
    ai_count: meta.cofacts_ai_checks,
    has_url_context: Boolean(urlContext),
  });
  const result = await stage("synthesis", () => synthesize(input, moderation, evidence, env));
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
