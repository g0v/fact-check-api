import { LIMITS } from "../config";
import type { RelevantCandidate } from "../types/cofacts";
import type { Evidence } from "../types/fact-check";
import type { Fetcher } from "../utils/http";
import { sourceUrl } from "../utils/url";
import { array, enumValue, finiteNumber, optionalText, record, string } from "../utils/validation";
import { queryCofacts } from "./cofacts-client";

export const evidenceQuery = `query GetEvidence($id: String!) {
  GetArticle(id: $id) {
    id text
    references { type permalink }
    articleReplies(statuses: [NORMAL]) {
      replyType positiveFeedbackCount negativeFeedbackCount
      reply { id text type reference hyperlinks { url normalizedUrl title } }
    }
    aiReplies { status text createdAt }
  }
}`;

const replyVerdicts = {
  NOT_RUMOR: "supports",
  RUMOR: "refutes",
  OPINIONATED: "opinion",
  NOT_ARTICLE: "unknown",
} as const;

export function normalizeCofactsEvidence(value: unknown, candidate: RelevantCandidate): Evidence[] {
  const article = record(value);
  if (article.id !== candidate.articleId) throw new Error("查核證據的文章 ID 不符。");
  const common = {
    articleId: candidate.articleId,
    articleText: (optionalText(article.text) ?? candidate.text).slice(0, LIMITS.evidenceText),
    cofactsUrl: `https://cofacts.tw/article/${encodeURIComponent(candidate.articleId)}`,
    ...(candidate.searchScore === null ? {} : { retrievalScore: candidate.searchScore }),
    relevanceScore: candidate.relevanceScore,
    articleReferences: array(article.references ?? [])
      .filter((item) => item !== null)
      .map((item) => sourceUrl(record(item).permalink))
      .filter((url): url is string => Boolean(url)),
  };
  const evidence: Evidence[] = [];
  for (const value of array(article.articleReplies).slice(0, LIMITS.repliesPerArticle)) {
    const link = record(value);
    if (link.reply === null) continue;
    const reply = record(link.reply);
    const text = optionalText(reply.text);
    if (!text) continue;
    const classification = enumValue(reply.type, [
      "NOT_RUMOR",
      "RUMOR",
      "OPINIONATED",
      "NOT_ARTICLE",
    ]);
    const referenceText = optionalText(reply.reference);
    const hyperlinks = array(reply.hyperlinks ?? [])
      .filter((item) => item !== null)
      .map((item) => {
        const hyperlink = record(item);
        return sourceUrl(hyperlink.normalizedUrl) ?? sourceUrl(hyperlink.url);
      });
    const referenceLinks = (referenceText?.match(/https?:\/\/[^\s<>"）)]+/g) ?? []).map(sourceUrl);
    const sourceUrls = [
      ...new Set([...referenceLinks, ...hyperlinks].filter((url): url is string => Boolean(url))),
    ].slice(0, 20);
    evidence.push({
      ...common,
      source: "cofacts-human",
      reliability: "human-community",
      evidenceText: text.slice(0, LIMITS.evidenceText),
      classification,
      verdict: replyVerdicts[classification],
      referenceText: referenceText?.slice(0, LIMITS.evidenceText),
      sourceUrls,
      sourceUrl: sourceUrls[0],
      positiveFeedback: finiteNumber(link.positiveFeedbackCount),
      negativeFeedback: finiteNumber(link.negativeFeedbackCount),
    });
  }
  for (const value of array(article.aiReplies).slice(0, LIMITS.repliesPerArticle)) {
    const reply = record(value);
    if (reply.status !== "SUCCESS") continue;
    const text = optionalText(reply.text);
    if (!text) continue;
    string(reply.createdAt, 100);
    evidence.push({
      ...common,
      source: "cofacts-ai",
      reliability: "ai-generated",
      evidenceText: text.slice(0, LIMITS.evidenceText),
    });
  }
  return evidence;
}

export async function getCofactsEvidence(
  candidates: RelevantCandidate[],
  fetcher: Fetcher = fetch,
): Promise<{ evidence: Evidence[]; failedArticleIds: string[] }> {
  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const data = await queryCofacts(evidenceQuery, { id: candidate.articleId }, fetcher);
      return normalizeCofactsEvidence(data.GetArticle, candidate);
    }),
  );
  const evidence: Evidence[] = [];
  const failedArticleIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") evidence.push(...result.value);
    else failedArticleIds.push(candidates[index].articleId);
  });
  return { evidence, failedArticleIds };
}
