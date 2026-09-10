import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../src/api";
import { LIMITS, MODELS } from "../src/api/config";
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
      no_relevant_evidence: false,
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
    expect(synthesis.evidence[0]).toMatchObject({
      source: "cofacts-human",
      evidenceText: "測試人工查核說明。",
      untrustedArticleText: "測試用原始自學補助主張。",
      referenceText: "參考測試來源 https://example.com/source",
      sourceUrls: ["https://example.com/source"],
    });
    expect(synthesis.evidence[1]).toMatchObject({
      source: "cofacts-ai",
      evidenceText: "測試 AI 回覆。",
      untrustedArticleText: "測試用原始自學補助主張。",
    });
    for (const item of synthesis.evidence) {
      expect(item).not.toHaveProperty("articleText");
      expect(item).not.toHaveProperty("articleReferences");
    }
    expect(h.run.mock.calls[1][1].messages[0].content).toContain(
      "絕對不得把 untrustedArticleText 本身當成支持或反駁 claim 的證據",
    );
    expect(JSON.stringify(synthesis)).not.toContain("https://example.com/original");
    expect(JSON.stringify(synthesis)).not.toContain("國中小性教育");
    const logs = JSON.stringify(h.log.mock.calls);
    for (const event of ["relevance_model_request", "relevance_model_response"])
      expect(h.log).toHaveBeenCalledWith(
        expect.objectContaining({ event, request_id: result.meta.request_id }),
      );
    expect(h.log).toHaveBeenCalledWith({
      event: "relevance",
      request_id: result.meta.request_id,
      candidate_count: 2,
      article_ids: relevanceOutput.results.map((item) => item.article_id),
      relevant_flags: relevanceOutput.results.map((item) => item.relevant),
      relevance_scores: relevanceOutput.results.map((item) => item.relevance),
      relevance_threshold: LIMITS.relevanceThreshold,
      selection_limit: LIMITS.relevant,
      selected_count: 1,
      selected_article_ids: ["relevant"],
    });
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

  it("allow 卻附分類時改判 block，不呼叫其他服務", async () => {
    const h = harness({
      moderation: { decision: "allow", categories: ["hate"], reason: "含有仇恨內容。" },
    });
    const result = await factCheck({ text: claim, url: "https://example.com" }, h.env, h);
    expect(result).toMatchObject({
      status: "blocked",
      verdict: null,
      factuality: null,
      confidence: null,
      related_checks: [],
    });
    expect(result.moderation).toEqual({
      decision: "block",
      categories: ["hate"],
      reason: "含有仇恨內容。",
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each([{ safetyFailure: true }, { moderation: { decision: "allow" } }])(
    "安全層失敗時跳過安全分類並繼續查核：%j",
    async (options) => {
      const h = harness(options);
      const result = await factCheck({ text: claim }, h.env, h);
      expect(result.status).toBe("partial");
      expect(result.moderation).toMatchObject({ decision: "skipped", categories: [] });
      expect(result.meta.warnings).toContainEqual({
        stage: "moderation",
        code: "UPSTREAM_UNAVAILABLE",
      });
      expect(result.related_checks.map((item) => item.type)).toEqual([
        "cofacts_human",
        "cofacts_ai",
      ]);
      expect(
        h.fetcher.mock.calls.filter(([url]) => String(url).includes("openrouter.ai")),
      ).toHaveLength(1);
      expect(h.run).toHaveBeenCalledTimes(2);
    },
  );

  it("缺少金鑰是設定錯誤，不跳過安全層，仍回 502", async () => {
    const h = harness();
    h.env.OPENROUTER_API_KEY = undefined;
    await expect(factCheck({ text: claim }, h.env, h)).rejects.toMatchObject({
      status: 502,
      stage: "moderation",
    });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

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
      meta: { no_relevant_evidence: true },
    });
    expect(h.run.mock.calls.at(-1)?.[0]).toBe(MODELS.synthesis);
    expect(JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content).evidence).toEqual([]);
  });

  it("沒有證據時採常識判斷，confidence 下修至 0.5", async () => {
    const h = harness({ edges: [] });
    const result = await factCheck({ text: claim }, h.env, h);
    expect(result).toMatchObject({
      status: "completed",
      factuality: 0.75,
      confidence: 0.5,
      verdict: "mostly_supported",
      related_checks: [],
      meta: { no_relevant_evidence: true },
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
    "%s 失敗且有 URL 時一律回 502，URL 不作為 fallback",
    async (stage) => {
      const h = harness({
        searchFailure: stage === "cofacts-search",
        relevanceFailure: stage === "relevance",
      });
      await expect(
        factCheck({ text: claim, url: "https://example.com" }, h.env, h),
      ).rejects.toMatchObject({ status: 502, stage });
      expect(h.run.mock.calls.some(([model]) => model === MODELS.synthesis)).toBe(false);
    },
  );

  it("只有使用者網址而無 Cofacts 證據時，URL 不進模型也不進 related_checks", async () => {
    const h = harness({ edges: [] });
    const result = await factCheck({ text: claim, url: "https://example.com" }, h.env, h);
    expect(result.status).toBe("completed");
    expect(result.meta.no_relevant_evidence).toBe(true);
    expect(result.meta.url_context_used).toBe(true);
    expect(result.meta.url_context_allowlisted).toBe(false);
    expect(result.meta.cofacts_human_checks).toBe(0);
    expect(result.meta.cofacts_ai_checks).toBe(0);
    expect(result.related_checks).toEqual([]);
    // url-only 走常識判斷契約：模型收空證據，信心值被下修至 0.5。
    const payload = JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content);
    expect(payload.evidence).toEqual([]);
    expect(h.run.mock.calls.at(-1)![1].messages[0].content).toContain("常識");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it.each([
    "https://gov.tw/report",
    "https://school.edu.tw/report",
    "https://www.nccu.edu.tw/",
    "https://tfc-taiwan.org.tw/articles/123",
  ])("Cofacts 無證據時採用白名單機構網址：%s", async (url) => {
    const h = harness({ edges: [] });
    const result = await factCheck({ text: claim, url }, h.env, h);
    expect(result.status).toBe("completed");
    expect(result.meta.no_relevant_evidence).toBe(false);
    expect(result.meta.url_context_used).toBe(true);
    expect(result.meta.url_context_allowlisted).toBe(true);
    expect(result.related_checks).toEqual([]);
    const payload = JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content);
    expect(payload.evidence).toEqual([
      expect.objectContaining({
        source: "provided-url",
        reliability: "allowlisted-institution",
        sourceUrl: url,
      }),
    ]);
    expect(result.confidence).toBe(0.6);
  });

  it.each([
    "https://fakegov.tw",
    "https://gov.tw.example.com",
    "http://tfc-taiwan.org.tw",
    "https://www.tfc-taiwan.org.tw",
    "https://tfc-taiwan.org.tw.evil.example",
  ])("相似但不在白名單的網址仍不能單獨作為證據：%s", async (url) => {
    const h = harness({ edges: [] });
    const result = await factCheck({ text: claim, url }, h.env, h);
    expect(result.meta.no_relevant_evidence).toBe(true);
    expect(result.meta.url_context_allowlisted).toBe(false);
    expect(JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content).evidence).toEqual([]);
    expect(result.confidence).toBe(0.5);
  });

  it("cofacts 與 URL 混合時 provided-url 仍正常進入 evidence", async () => {
    const h = harness();
    const result = await factCheck({ text: claim, url: "https://example.com" }, h.env, h);
    expect(result.status).toBe("completed");
    expect(result.meta.url_context_used).toBe(true);
    const payload = JSON.parse(h.run.mock.calls.at(-1)![1].messages[1].content);
    expect(payload.evidence.map((item: { source: string }) => item.source)).toEqual([
      "cofacts-human",
      "cofacts-ai",
      "provided-url",
    ]);
  });

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
    expect(result.meta.no_relevant_evidence).toBe(true);
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
    "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=A0000001",
    "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=A0000001&flno=1",
  ])("GET 完整保留背景網址的 query string：%s", async (url) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const params = new URLSearchParams({ text: claim, url });

    const response = await api.request(`/fact-check?${params}`, {}, h.env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url });
    expect(h.fetcher.mock.calls.some(([input]) => String(input) === url)).toBe(true);
  });

  it("GET 可直接解析背景網址內未轉義的單一 query string", async () => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const url = "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=A0000001";

    const response = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}&url=${url}`,
      {},
      h.env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url });
    expect(h.fetcher.mock.calls.some(([input]) => String(input) === url)).toBe(true);
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

  it.each([
    ["https://civic.vtaiwan.tw", true],
    ["http://localhost:5173", true],
    ["http://localhost:4173", true],
    ["http://127.0.0.1:8787", true],
    ["https://localhost:5173", false],
  ])("GET 對指定來源套用 CORS：%s", async (origin, allowed) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers: { Origin: origin } },
      h.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(allowed ? origin : null);
    expect(response.headers.get("Vary")).toBe(allowed ? "Origin" : null);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
  it("GET 驗證錯誤也帶允許來源的 CORS header", async () => {
    const h = harness();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await api.request(
      "/fact-check?text=",
      { headers: { Origin: "https://civic.vtaiwan.tw" } },
      h.env,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://civic.vtaiwan.tw");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(await response.json()).toMatchObject({ status: "error", error: "INVALID_INPUT" });
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
    const response = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers: { Origin: "https://civic.vtaiwan.tw" } },
      h.env,
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://civic.vtaiwan.tw");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const body = await response.text();
    expect(body + JSON.stringify(log.mock.calls)).not.toContain("your-openrouter-api-key");
    expect(body).not.toContain("模擬上游診斷文字");
  });
});
