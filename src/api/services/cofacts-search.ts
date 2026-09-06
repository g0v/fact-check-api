import { LIMITS } from "../config";
import type { CofactsCandidate } from "../types/cofacts";
import { upstreamError } from "../utils/errors";
import type { Fetcher } from "../utils/http";
import { array, finiteNumber, record, string } from "../utils/validation";
import { queryCofacts } from "./cofacts-client";

export const searchQuery = `query Search($text: String!) {
  ListArticles(filter: { moreLikeThis: { like: $text, minimumShouldMatch: "30%" } },
    orderBy: [{ _score: DESC }], first: ${LIMITS.candidates}) {
    edges { score node { id text } }
  }
}`;

export async function searchCofactsCandidates(
  text: string,
  fetcher: Fetcher = fetch,
): Promise<CofactsCandidate[]> {
  try {
    const data = await queryCofacts(searchQuery, { text }, fetcher);
    const candidates: CofactsCandidate[] = [];
    const ids = new Set<string>();
    for (const edgeValue of array(record(data.ListArticles).edges).slice(0, LIMITS.candidates)) {
      const edge = record(edgeValue);
      const node = record(edge.node);
      const articleId = string(node.id, 200);
      if (node.text === null || node.text === "") continue;
      if (ids.has(articleId)) throw new Error("候選文章 ID 重複。");
      ids.add(articleId);
      candidates.push({
        articleId,
        text: string(node.text, 1_000_000),
        searchScore: edge.score === null ? null : finiteNumber(edge.score),
      });
    }
    return candidates;
  } catch {
    throw upstreamError("cofacts-search");
  }
}
