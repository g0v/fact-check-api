import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../src/api";
import { MODELS } from "../src/api/config";
import { factCheck } from "../src/api/services/fact-check";
import { claim, emptySynthesisOutput, harness, relevanceOutput } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("完整查核流程（模擬外部傳輸）", () => {
  it("以相關性保留低搜尋分數文章，分開人工與 AI 證據", async () => {
    const h = harness();
    const result = await factCheck({ text: claim }, h.env, h);
    expect(result.status).toBe("completed");
    expect(result.meta).toMatchObject({
      cofacts_candidates: 2,
      cofacts_relevant: 1,
      cofacts_human_checks: 1,
      cofacts_ai_checks: 1,
    });
    expect(result.related_checks.map((item) => item.type)).toEqual(["cofacts_human", "cofacts_ai"]);
    expect(result.related_checks[0]).toMatchObject({
      retrieval_score: 0.02,
      relevance_score: 0.96,
      reference_url: "https://example.com/source",
      url: "https://cofacts.tw/article/relevant",
    });
    const calls = h.fetcher.mock.calls.filter(([url]) => String(url).includes("api.cofacts.tw"));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1][1]?.body)).variables.id).toBe("relevant");
    const input = JSON.parse(h.run.mock.calls[0][1].messages[1].content);
    expect(input.candidates[0]).toEqual({
      articleId: "unrelated",
      text: "測試文章：國中小性教育課程。",
    });
    const synthesis = JSON.parse(h.run.mock.calls[1][1].messages[1].content);
    expect(synthesis.evidence.map((item: { source: string }) => item.source)).toEqual([
      "cofacts-human",
      "cofacts-ai",
    ]);
    expect(JSON.stringify(synthesis)).not.toContain("國中小性教育");
    const logs = JSON.stringify(h.log.mock.calls);
    expect(logs).not.toContain(claim);
    expect(logs).not.toContain("your-openrouter-api-key");
    expect(logs).not.toContain("測試人工查核說明");
  });

  it("block 後不呼叫其他服務；review 保留並繼續", async () => {
    const blocked = harness({ decision: "block" });
    const result = await factCheck(
      { text: claim, url: "https://example.com" },
      blocked.env,
      blocked,
    );
    expect(result).toMatchObject({
      status: "blocked",
      verdict: null,
      factuality: null,
      confidence: null,
      related_checks: [],
    });
    expect(blocked.fetcher).toHaveBeenCalledTimes(1);
    expect(blocked.run).not.toHaveBeenCalled();
    const review = harness({ decision: "review" });
    expect((await factCheck({ text: claim }, review.env, review)).moderation.decision).toBe(
      "review",
    );
    expect(review.run).toHaveBeenCalledTimes(2);
  });

  it.each([{ safetyFailure: true }, { moderation: { decision: "allow" } }])(
    "安全層失敗不放行：%j",
    async (options) => {
      const h = harness(options);
      await expect(factCheck({ text: claim }, h.env, h)).rejects.toMatchObject({
        status: 502,
        stage: "moderation",
      });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(h.run).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("無相關證據是正常結果（候選為空：%s）", async (emptySearch) => {
    const h = harness({
      ...(emptySearch
        ? { edges: [] }
        : {
            relevance: {
              results: relevanceOutput.results.map((item) => ({ ...item, relevant: false })),
            },
          }),
      synthesis: emptySynthesisOutput,
    });
    const result = await factCheck({ text: claim }, h.env, h);
    expect(result).toMatchObject({
      status: "completed",
      verdict: "insufficient_evidence",
      related_checks: [],
    });
    expect(h.run.mock.calls.at(-1)?.[0]).toBe(MODELS.synthesis);
    expect(JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content).evidence).toEqual([]);
  });

  it("沒有證據時拒絕模型靠記憶判真", async () => {
    const h = harness({ edges: [] });
    await expect(factCheck({ text: claim }, h.env, h)).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
  });

  it.each(["cofacts-search", "relevance"] as const)("%s 失敗且無 URL 時回 502", async (stage) => {
    const h = harness({
      searchFailure: stage === "cofacts-search",
      relevanceFailure: stage === "relevance",
    });
    await expect(factCheck({ text: claim }, h.env, h)).rejects.toMatchObject({
      status: 502,
      stage,
    });
    expect(h.run.mock.calls.some(([model]) => model === MODELS.synthesis)).toBe(false);
  });

  it.each(["cofacts-search", "relevance"] as const)(
    "%s 失敗且有 URL 時回 partial，只綜整 URL",
    async (stage) => {
      const h = harness({
        searchFailure: stage === "cofacts-search",
        relevanceFailure: stage === "relevance",
      });
      const result = await factCheck({ text: claim, url: "https://example.com" }, h.env, h);
      expect(result.status).toBe("partial");
      expect(result.meta.warnings).toEqual([{ stage, code: "UPSTREAM_UNAVAILABLE" }]);
      expect(result.related_checks).toEqual([]);
      expect(JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content).evidence).toEqual([
        expect.objectContaining({ source: "provided-url", reliability: "user-provided" }),
      ]);
    },
  );

  it("URL 與搜尋皆失敗時不假裝有可用 URL", async () => {
    const h = harness({ searchFailure: true, urlFailure: true });
    await expect(
      factCheck({ text: claim, url: "https://example.com" }, h.env, h),
    ).rejects.toMatchObject({ stage: "cofacts-search" });
  });

  it("單筆詳細資料失敗與 URL 失敗皆保留警告", async () => {
    const h = harness({ detailFailure: true, urlFailure: true, synthesis: emptySynthesisOutput });
    const result = await factCheck({ text: claim, url: "https://example.com" }, h.env, h);
    expect(result.status).toBe("partial");
    expect(result.meta.warnings.map((item) => item.stage)).toEqual(["url", "cofacts-evidence"]);
    expect(result.related_checks).toEqual([]);
  });

  it("Gemma 失敗回 502，不自行拼湊 factuality", async () => {
    const h = harness({ synthesisFailure: true });
    await expect(factCheck({ text: claim }, h.env, h)).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
  });
});

describe("Hono GET／POST 介面", () => {
  it.each(["GET", "POST"])("%s 經過相同完整 pipeline，回應禁止快取", async (method) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await api.request(
      method === "GET" ? `/fact-check?text=${encodeURIComponent(`  ${claim}  `)}` : "/fact-check",
      {
        method,
        ...(method === "POST"
          ? {
              headers: { "Content-Type": "application/json", Origin: "http://localhost" },
              body: JSON.stringify({ text: `  ${claim}  ` }),
            }
          : {}),
      },
      h.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      text: claim,
      status: "completed",
      meta: { request_id: response.headers.get("X-Request-Id") },
    });
  });

  it.each([
    {},
    { text: "   " },
    { text: 2 },
    { text: "字".repeat(10_001) },
    { text: claim, url: "file:///tmp/test" },
    { text: claim, url: "http://127.0.0.1" },
    { text: claim, url: null },
  ])("無效輸入回 400 且不呼叫上游", async (body) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify(body),
      },
      h.env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "error", error: "INVALID_INPUT" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("安全層錯誤不將上游內容或 credential 放入 response／log", async () => {
    const h = harness();
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("your-openrouter-api-key 模擬上游診斷文字");
      }),
    );
    const response = await api.request(`/fact-check?text=${encodeURIComponent(claim)}`, {}, h.env);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body + JSON.stringify(log.mock.calls)).not.toContain("your-openrouter-api-key");
    expect(body).not.toContain("模擬上游診斷文字");
  });
});
