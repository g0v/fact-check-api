import { describe, expect, it } from "vite-plus/test";
import { filterRelevantCandidates } from "../src/api/services/relevance-filter";
import { completion, harness } from "./helpers";

describe("相關性分數與請求隔離", () => {
  it.each(["response", "choices"])(
    "%s 回傳十五筆不同分數且順序顛倒時，逐筆保留數值並依 ID 對應文章",
    async (format) => {
      const candidates = Array.from({ length: 15 }, (_, i) =>
        Object.freeze({ articleId: String(i), text: `測試文章 ${i}`, searchScore: 100 - i }),
      );
      Object.freeze(candidates);
      const modelResults = candidates
        .map((item, i) => ({
          article_id: item.articleId,
          relevant: i % 3 !== 0,
          relevance: i / 15,
          reason: `模型測試理由 ${i}`,
        }))
        .reverse();
      const payload = { results: modelResults };
      const output =
        format === "response" ? { response: JSON.stringify(payload) } : completion(payload);
      const originalOutput = structuredClone(output);
      const h = harness();
      h.run.mockResolvedValue(output);
      const result = await filterRelevantCandidates("測試主張", candidates, h.env, h.log);

      expect(result.results).toEqual(
        modelResults.map((item) => ({
          articleId: item.article_id,
          relevant: item.relevant,
          relevance: item.relevance,
          reason: item.reason,
        })),
      );
      expect(result.selected.map((item) => item.articleId)).toEqual(["14", "13", "11", "10", "8"]);
      for (const item of result.selected) {
        expect(item.text).toBe(`測試文章 ${item.articleId}`);
        expect(item.relevanceScore).toBe(Number(item.articleId) / 15);
        expect(item.searchScore).toBe(100 - Number(item.articleId));
      }
      expect(output).toEqual(originalOutput);
      expect(JSON.parse(h.run.mock.calls[0][1].messages[1].content)).toEqual({
        claim: "測試主張",
        candidates: candidates.map(({ articleId, text }) => ({ articleId, text })),
      });
      expect(h.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "relevance_model_request",
          candidate_count: 15,
          distinct_text_count: 15,
        }),
      );
      expect(h.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "relevance_model_response",
          article_ids: modelResults.map((item) => item.article_id),
          model_relevance_scores: modelResults.map((item) => item.relevance),
          model_relevant_count: 10,
        }),
      );
      const logs = JSON.stringify(h.log.mock.calls);
      expect(logs).not.toContain("測試主張");
      expect(logs).not.toContain("測試文章");
      expect(logs).not.toContain("模型測試理由");
    },
  );

  it("同時查核且第二個請求先完成時，相同文章 ID 的分數與本文不互相覆寫", async () => {
    const h = harness();
    const pending = new Map<string, (value: unknown) => void>();
    h.run.mockImplementation(
      (_model, input) =>
        new Promise((resolve) => {
          pending.set(JSON.parse(input.messages[1].content).claim, resolve);
        }),
    );
    const first = filterRelevantCandidates(
      "主張甲",
      [{ articleId: "shared-id", text: "文章甲", searchScore: 10 }],
      h.env,
    );
    const second = filterRelevantCandidates(
      "主張乙",
      [{ articleId: "shared-id", text: "文章乙", searchScore: 20 }],
      h.env,
    );
    const output = (score: number, reason: string) => ({
      response: JSON.stringify({
        results: [{ article_id: "shared-id", relevant: true, relevance: score, reason }],
      }),
    });
    pending.get("主張乙")!(output(0.9, "理由乙"));
    const secondResult = await second;
    pending.get("主張甲")!(output(0.6, "理由甲"));
    const firstResult = await first;
    expect(firstResult.selected[0]).toMatchObject({
      text: "文章甲",
      searchScore: 10,
      relevanceScore: 0.6,
      relevanceReason: "理由甲",
    });
    expect(secondResult.selected[0]).toMatchObject({
      text: "文章乙",
      searchScore: 20,
      relevanceScore: 0.9,
      relevanceReason: "理由乙",
    });
    expect(firstResult.results[0].relevance).toBe(0.6);
    expect(secondResult.results[0].relevance).toBe(0.9);
  });

  it("模型全部給零分時忠實保留，並記錄送入模型的重複文字與截斷長度", async () => {
    const candidates = ["a", "b"].map((articleId) => ({
      articleId,
      text: "字".repeat(4_000),
      searchScore: null,
    }));
    const h = harness({
      relevance: {
        results: candidates.map(({ articleId }) => ({
          article_id: articleId,
          relevant: false,
          relevance: 0,
          reason: "測試不相關。",
        })),
      },
    });
    const result = await filterRelevantCandidates("測試主張", candidates, h.env, h.log);
    expect(result.results.map((item) => item.relevance)).toEqual([0, 0]);
    expect(result.selected).toEqual([]);
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "relevance_model_request",
        distinct_text_count: 1,
        source_text_lengths: [4_000, 4_000],
        sent_text_lengths: [3_000, 3_000],
      }),
    );
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "relevance_model_response",
        model_relevance_scores: [0, 0],
        model_relevant_count: 0,
      }),
    );
  });

  it("模型格式錯誤時不把自由文字或未知 ID 寫入診斷", async () => {
    const h = harness({
      relevance: {
        results: [
          {
            article_id: "your-openrouter-api-key",
            relevant: false,
            relevance: "不應記錄的模型文字",
            reason: "不應記錄的理由",
          },
        ],
      },
    });
    await expect(
      filterRelevantCandidates(
        "測試主張",
        [{ articleId: "known", text: "文章", searchScore: null }],
        h.env,
        h.log,
      ),
    ).rejects.toMatchObject({ stage: "relevance" });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "relevance_model_response",
        article_ids: ["unknown"],
        model_relevance_scores: [null],
      }),
    );
    const logs = JSON.stringify(h.log.mock.calls);
    expect(logs).not.toContain("your-openrouter-api-key");
    expect(logs).not.toContain("不應記錄");
  });
});
