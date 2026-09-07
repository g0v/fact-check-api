import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import FactCheckValue from "../src/components/FactCheckValue.vue";
import { fieldInfo, safeSourceLink } from "../src/client/fact-check-fields";
import { useFactCheckForm } from "../src/client/use-fact-check-form";
import app from "../src/index";

const responseData = {
  text: "測試主張",
  url: "https://example.org/background",
  status: "partial",
  moderation: { decision: "review", categories: ["privacy"], reason: "保留查核例外。" },
  factuality: 0,
  confidence: 0.123456789,
  verdict: "insufficient_evidence",
  feedback: "第一行\n第二行 <script>測試文字</script>",
  related_checks: [
    {
      type: "cofacts_human",
      text: "人工回覆",
      url: "https://cofacts.tw/article/example",
      reference_url: "https://example.org/source",
      reference_urls: ["https://example.org/source", "https://example.org/source"],
      classification: "NOT_RUMOR",
      retrieval_score: 12.3456789,
      relevance_score: 0.987654321,
    },
    {
      type: "cofacts_ai",
      text: "AI 回覆",
      url: "https://cofacts.tw/article/example",
    },
  ],
  meta: {
    request_id: "test-request-id",
    cofacts_candidates: 15,
    cofacts_relevant: 1,
    cofacts_human_checks: 1,
    cofacts_ai_checks: 1,
    url_context_used: false,
    no_relevant_evidence: false,
    warnings: [
      { stage: "cofacts-evidence", code: "UPSTREAM_UNAVAILABLE", article_id: "failed-article" },
    ],
  },
};

describe("首頁表單與結果（不使用瀏覽器自動化）", () => {
  it("SSR 保留說明與表單，僅首頁載入互動入口", async () => {
    const html = await (await app.request("/", {}, {})).text();
    expect(html).toContain('id="fact-check-app"');
    expect(html).toContain('action="/api/fact-check" method="post"');
    expect(html).toContain('type="module" src="/src/client/home.ts"');
    expect(html).toContain("第一個查核請求");
    expect(html).toMatch(/<button[^>]*disabled/);
    const about = await (await app.request("/about", {}, {})).text();
    expect(about).not.toContain('type="module"');
  });

  it("同源 POST 使用 JSON，省略未填網址並保留原始回應", async () => {
    const raw = JSON.stringify(responseData, null, 2);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(raw, {
        status: 200,
        headers: { "X-Request-Id": "header-id" },
      }),
    );
    const form = useFactCheckForm(fetcher);
    form.text.value = "  測試主張  ";
    form.url.value = "   ";
    await form.submit();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/fact-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "測試主張" }),
    });
    expect(form.result.value).toEqual({ data: responseData, raw, ok: true });
    expect(form.httpStatus.value).toBe(200);
    expect(form.requestId.value).toBe("header-id");
    expect(form.pending.value).toBe(false);
  });

  it("附帶網址且等待期間阻止重複送出", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const form = useFactCheckForm(fetcher);
    form.text.value = "測試主張";
    form.url.value = " https://example.org/background ";
    const request = form.submit();
    expect(form.pending.value).toBe(true);
    await form.submit();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      text: "測試主張",
      url: "https://example.org/background",
    });
    finish(Response.json(responseData));
    await request;
    expect(form.pending.value).toBe(false);
  });

  it.each([
    { text: "   ", url: "" },
    { text: "字".repeat(10001), url: "" },
    { text: "測試", url: "ftp://example.org" },
    { text: "測試", url: "https://user:placeholder@example.org" },
  ])("無效輸入不送出請求", async ({ text, url }) => {
    const fetcher = vi.fn<typeof fetch>();
    const form = useFactCheckForm(fetcher);
    form.text.value = text;
    form.url.value = url;
    await form.submit();
    expect(fetcher).not.toHaveBeenCalled();
    expect(form.error.value).not.toBe("");
  });

  it("Unicode 字數與 API 一致，不以 UTF-16 長度拒絕 emoji", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(responseData));
    const form = useFactCheckForm(fetcher);
    form.text.value = "😀".repeat(10000);
    expect(form.textLength.value).toBe(10000);
    await form.submit();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("API 錯誤、非 JSON 與連線失敗皆可重試，不殘留舊結果", async () => {
    const apiError = {
      status: "error",
      error: "UPSTREAM_UNAVAILABLE",
      message: "上游無法使用。",
      stage: "moderation",
      request_id: "error-id",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(apiError, { status: 502 }))
      .mockResolvedValueOnce(new Response("<h1>服務錯誤</h1>", { status: 503 }))
      .mockRejectedValueOnce(new Error("測試連線失敗"))
      .mockResolvedValueOnce(Response.json(responseData));
    const form = useFactCheckForm(fetcher);
    form.text.value = "測試主張";
    await form.submit();
    expect(form.result.value?.data).toEqual(apiError);
    expect(form.result.value?.ok).toBe(false);
    expect(form.httpStatus.value).toBe(502);
    await form.submit();
    expect(form.result.value?.raw).toBe("<h1>服務錯誤</h1>");
    expect(form.error.value).toContain("不是有效 JSON");
    await form.submit();
    expect(form.result.value).toBeNull();
    expect(form.httpStatus.value).toBeNull();
    expect(form.pending.value).toBe(false);
    expect(form.error.value).toContain("網路連線");
    await form.submit();
    expect(form.error.value).toBe("");
    expect(form.result.value?.data).toEqual(responseData);
  });

  it("所有回傳欄位皆有說明，數值、布林值與重複引用忠實呈現", async () => {
    function checkDescriptions(value: unknown, path = "") {
      if (Array.isArray(value)) {
        value.forEach((item) => checkDescriptions(item, `${path}[]`));
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key;
        expect(fieldInfo(next).label, next).not.toBe("額外欄位");
        checkDescriptions(item, next);
      }
    }
    checkDescriptions(responseData);
    const html = await renderToString(
      createSSRApp(FactCheckValue, { value: responseData, path: "" }),
    );
    for (const value of [
      "0.123456789",
      "12.3456789",
      "0.987654321",
      "false",
      "failed-article",
      "test-request-id",
      "cofacts_human",
      "cofacts_ai",
    ])
      expect(html).toContain(value);
    expect(html).toContain("不是百分比");
    expect(html).toContain("證據不足，無法判定");
    expect(html.match(/href="https:\/\/example.org\/source"/g)).toHaveLength(3);
    expect(html).toContain("&lt;script&gt;測試文字&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("blocked 的 null 與空陣列、未知欄位都不被補成替代數值", async () => {
    const html = await renderToString(
      createSSRApp(FactCheckValue, {
        value: {
          status: "blocked",
          factuality: null,
          confidence: null,
          verdict: null,
          related_checks: [],
          extra: "原值",
        },
        path: "",
      }),
    );
    expect(html.match(/null（沒有值，並非 0）/g)).toHaveLength(3);
    expect(html).toContain("[]（空陣列）");
    expect(html).toContain("安全層停止查核");
    expect(html).toContain("額外欄位");
    expect(html).toContain("原值");
    expect(fieldInfo("__proto__").label).toBe("額外欄位");
  });

  it("快取命中資訊有中文含義並保留原始時間", async () => {
    const cache = {
      status: "hit",
      cached_at: "2026-09-07T00:00:00.000Z",
      expires_at: "2026-09-07T01:00:00.000Z",
    };
    const html = await renderToString(
      createSSRApp(FactCheckValue, { value: { meta: { cache } }, path: "" }),
    );
    expect(html).toContain("使用快取結果");
    expect(html).toContain("本次不重跑模型");
    expect(html).toContain(cache.cached_at);
    expect(html).toContain(cache.expires_at);
    expect(html).not.toContain("額外欄位");
  });

  it("來源網址僅允許 HTTP／HTTPS，危險內容保持純文字", async () => {
    expect(safeSourceLink("related_checks[].url", "javascript:alert(1)")).toBeUndefined();
    expect(safeSourceLink("url", "data:text/html,example")).toBeUndefined();
    expect(safeSourceLink("url", "https://user:placeholder@example.org")).toBeUndefined();
    const html = await renderToString(
      createSSRApp(FactCheckValue, { value: { url: "javascript:alert(1)" }, path: "" }),
    );
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toContain("href=");
  });
});
