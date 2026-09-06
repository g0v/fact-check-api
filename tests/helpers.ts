import { vi } from "vite-plus/test";
import { MODELS } from "../src/api/config";
import type { ApiBindings } from "../src/api/types/fact-check";
import type { Fetcher } from "../src/api/utils/http";

export const claim = "測試主張：國中小自學生缺乏普遍補助。";
export const candidateEdges = [
  { score: 300, node: { id: "unrelated", text: "測試文章：國中小性教育課程。" } },
  { score: 0.02, node: { id: "relevant", text: "測試文章：國中小自學補助方案。" } },
];
export const relevanceOutput = {
  results: [
    { article_id: "unrelated", relevant: false, relevance: 0.1, reason: "只有主題字詞重疊。" },
    { article_id: "relevant", relevant: true, relevance: 0.96, reason: "直接討論自學補助。" },
  ],
};
export const synthesisOutput = {
  factuality: 0.75,
  confidence: 0.6,
  verdict: "mostly_supported",
  feedback: "測試證據支持部分主張，仍須確認適用範圍。",
};
export const emptySynthesisOutput = {
  factuality: 0.5,
  confidence: 0.1,
  verdict: "insufficient_evidence",
  feedback: "目前證據不足，無法判定。",
};
export function completion(value: unknown) {
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] };
}
export function article(id = "relevant") {
  return {
    id,
    text: "測試用原始自學補助主張。",
    references: [{ type: "URL", permalink: "https://example.com/original" }],
    articleReplies: [
      {
        replyType: "NOT_RUMOR",
        positiveFeedbackCount: 3,
        negativeFeedbackCount: 1,
        reply: {
          id: "reply-1",
          type: "NOT_RUMOR",
          text: "測試人工查核說明。",
          reference: "參考測試來源 https://example.com/source",
          hyperlinks: [
            {
              url: "https://example.com/source",
              normalizedUrl: "https://example.com/source",
              title: "測試來源",
            },
          ],
        },
      },
    ],
    aiReplies: [
      { status: "SUCCESS", text: "測試 AI 回覆。", createdAt: "2026-09-01T00:00:00Z" },
      { status: "ERROR", text: "不應採用的失敗回覆。", createdAt: "2026-09-01T00:00:00Z" },
    ],
  };
}

export function harness(
  options: {
    decision?: string;
    moderation?: unknown;
    safetyFailure?: boolean;
    searchFailure?: boolean;
    edges?: typeof candidateEdges;
    detailFailure?: boolean;
    relevance?: unknown;
    relevanceFailure?: boolean;
    synthesis?: unknown;
    synthesisFailure?: boolean;
    urlFailure?: boolean;
  } = {},
) {
  const fetcher = vi.fn<Fetcher>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "openrouter.ai") {
      if (options.safetyFailure) return new Response("服務錯誤", { status: 500 });
      return Response.json(
        completion(options.moderation ?? { decision: options.decision ?? "allow", categories: [] }),
      );
    }
    if (url.hostname === "api.cofacts.tw") {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query Search")) {
        if (options.searchFailure) return Response.json({ errors: [{ message: "測試用錯誤" }] });
        return Response.json({
          data: { ListArticles: { edges: options.edges ?? candidateEdges } },
        });
      }
      if (options.detailFailure) return new Response("服務錯誤", { status: 500 });
      return Response.json({ data: { GetArticle: article(body.variables.id) } });
    }
    if (url.hostname === "cloudflare-dns.com")
      return Response.json({
        Status: 0,
        Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.215.14" }] : [],
      });
    if (options.urlFailure) return new Response("服務錯誤", { status: 500 });
    return new Response("測試用 URL 內容。", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });
  const run = vi.fn<NonNullable<ApiBindings["AI"]>["run"]>(async (model) => {
    if (model === MODELS.relevance) {
      if (options.relevanceFailure) throw new Error("初篩測試失敗。");
      return { response: JSON.stringify(options.relevance ?? relevanceOutput) };
    }
    if (model !== MODELS.synthesis) throw new Error("使用未預期的模型。");
    if (options.synthesisFailure) throw new Error("綜整測試失敗。");
    return completion(options.synthesis ?? synthesisOutput);
  });
  const env: ApiBindings = { OPENROUTER_API_KEY: "your-openrouter-api-key", AI: { run } };
  return { env, fetcher, run, log: vi.fn() };
}
