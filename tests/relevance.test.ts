import { describe, expect, it } from "vite-plus/test";
import { filterRelevantCandidates } from "../src/api/services/relevance-filter";
import { normalizeCofactsEvidence } from "../src/api/services/cofacts-evidence";
import { LIMITS } from "../src/api/config";
import fixture from "./fixtures/relevance-cases.json";
import { article, harness } from "./helpers";

describe("初篩契約與工程藍圖回歸案例", () => {
  it("套用藍圖標註的模擬模型輸出，保留唯一相關 ID", async () => {
    // 摘要只是傳輸測試內容；真正的模型能力另由 opt-in live 測試驗收。
    const candidates = fixture.candidates.map((item, index) => ({
      articleId: item.id,
      text: `測試摘要：${item.reason}`,
      searchScore: 100 - index * 20,
    }));
    const h = harness({
      relevance: {
        results: fixture.candidates.map((item) => ({
          article_id: item.id,
          relevant: item.expected,
          relevance: item.expected ? 0.96 : 0.03,
          reason: item.reason,
        })),
      },
    });
    const result = await filterRelevantCandidates(fixture.claim, candidates, h.env);
    expect(result.selected.map((item) => item.articleId)).toEqual(["3fygvjl81j6co"]);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("0.65 含邊界、最多五篇、保留本地全文並限制模型文字", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      articleId: String(i),
      text: "字".repeat(5_000),
      searchScore: i,
    }));
    const scores = [0.64, 0.65, 0.7, 0.9, 0.8, 0.66, 0.99, 1];
    const h = harness({
      relevance: {
        results: candidates.map((item, i) => ({
          article_id: item.articleId,
          relevant: i !== 7,
          relevance: scores[i],
          reason: "測試相關性。",
        })),
      },
    });
    const result = await filterRelevantCandidates("測試主張", candidates, h.env);
    expect(result.selected.map((item) => item.articleId)).toEqual(["6", "3", "4", "2", "5"]);
    expect(result.results.find((item) => item.articleId === "1")?.relevance).toBe(0.65);
    expect(result.selected[0].text.length).toBe(5_000);
    expect(JSON.parse(h.run.mock.calls[0][1].messages[1].content).candidates[0].text.length).toBe(
      LIMITS.candidateText,
    );
    const boundary = harness({
      relevance: {
        results: [{ article_id: "1", relevant: true, relevance: 0.65, reason: "測試門檻。" }],
      },
    });
    expect(
      (await filterRelevantCandidates("測試主張", [candidates[1]], boundary.env)).selected,
    ).toHaveLength(1);
  });

  it.each([
    [],
    [{ article_id: "invented", relevant: true, relevance: 0.9, reason: "測試" }],
    [{ article_id: "1", relevant: true, relevance: 1.1, reason: "測試" }],
    [{ article_id: "1", relevant: "true", relevance: 0.9, reason: "測試" }],
    [0, 1].map(() => ({ article_id: "1", relevant: true, relevance: 0.9, reason: "測試" })),
  ])("拒絕缺漏、虛構、越界或重複輸出：%j", async (...results) => {
    const h = harness({ relevance: { results } });
    await expect(
      filterRelevantCandidates(
        "測試",
        [{ articleId: "1", text: "文章", searchScore: null }],
        h.env,
      ),
    ).rejects.toMatchObject({ stage: "relevance" });
  });

  it("來源引用不會把原始訊息出處當成人工查核引文", () => {
    const data = article();
    data.articleReplies[0].reply.hyperlinks = [];
    data.articleReplies[0].reply.reference = "";
    const result = normalizeCofactsEvidence(data, {
      articleId: "relevant",
      text: "文章",
      searchScore: null,
      relevanceScore: 0.9,
      relevanceReason: "測試",
    });
    expect(result[0].sourceUrl).toBeUndefined();
    expect(result[0].articleReferences).toEqual(["https://example.com/original"]);
    expect(result[0].retrievalScore).toBeUndefined();
    expect(result.map((item) => item.source)).toEqual(["cofacts-human", "cofacts-ai"]);
  });
});
