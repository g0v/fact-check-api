import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import FactCheckResult from "../src/components/FactCheckResult.vue";
import {
  confidenceText,
  factualityText,
  summarizeFactCheck,
} from "../src/client/fact-check-summary";

const responseData = {
  text: "測試主張",
  status: "completed",
  moderation: { decision: "allow", categories: [] },
  factuality: 0.7,
  confidence: 0.123456789,
  verdict: "mostly_supported",
  related_checks: [
    {
      type: "cofacts_human",
      text: "人工回覆內容",
      url: "https://cofacts.tw/article/example",
      reference_url: "https://example.org/source",
      reference_urls: ["https://example.org/source", "https://example.org/another"],
      classification: "NOT_RUMOR",
      retrieval_score: 12.3456789,
      relevance_score: 0.987654321,
    },
    { type: "cofacts_ai", text: "AI 回覆內容", url: "https://cofacts.tw/article/example" },
  ],
  feedback: "查核說明 <script>測試文字</script>",
  meta: { request_id: "test-request-id", warnings: [] },
};

function render(data: unknown) {
  return renderToString(createSSRApp(FactCheckResult, { data }));
}

describe("支持度與信心的文字分級", () => {
  it.each([
    [1, "可確信"],
    [0.75, "可確信"],
    [0.74, "可相當確信"],
    [0.51, "可相當確信"],
    // issue #10 常識判斷下修至 0.5，必須讀作低信心。
    [0.5, "不大肯定"],
    [0.25, "不大肯定"],
    [0.24, "非常不肯定"],
    [0, "非常不肯定"],
  ])("confidence %f → %s", (value, expected) => {
    expect(confidenceText(value)).toBe(expected);
  });

  it.each([
    [1, "此陳述為真"],
    [0.8, "此陳述為真"],
    [0.79, "此陳述大致為真"],
    [0.6, "此陳述大致為真"],
    [0.59, "此陳述真偽參半"],
    [0.5, "此陳述依查核資料無法判定"],
    [0.36, "此陳述真偽參半"],
    [0.35, "此陳述大致為假"],
    [0.21, "此陳述大致為假"],
    [0.2, "此陳述為假"],
    [0, "此陳述為假"],
  ])("factuality %f → %s", (value, expected) => {
    expect(factualityText(value, "mixed")).toBe(expected);
  });

  it("insufficient_evidence 不以數字換算真假文字", () => {
    expect(factualityText(0.5, "insufficient_evidence")).toBe("此陳述依查核資料無法判定");
    expect(factualityText(0.9, "insufficient_evidence")).toBe("此陳述依查核資料無法判定");
  });
});

describe("查核結果摘要組裝", () => {
  it("完整回應產生摘要，其餘欄位保留原始順序", () => {
    const summary = summarizeFactCheck(responseData);
    expect(summary).toMatchObject({
      verdict: "mostly_supported",
      verdictText: "證據大致支持",
      factuality: 0.7,
      confidence: 0.123456789,
      assessment: "非常不肯定，此陳述大致為真",
      feedback: responseData.feedback,
    });
    expect(summary?.relatedChecks).toHaveLength(2);
    expect(Object.keys(summary?.rest ?? {})).toEqual(["text", "status", "moderation", "meta"]);
  });

  it("常識判斷下修後的 0.5 信心讀作不大肯定", () => {
    const summary = summarizeFactCheck({ ...responseData, confidence: 0.5 });
    expect(summary?.assessment).toBe("不大肯定，此陳述大致為真");
  });

  it.each([
    ["blocked 回應", { status: "blocked", verdict: null, factuality: null }],
    ["錯誤回應", { status: "error", error: "INVALID_INPUT", message: "測試" }],
    ["未知 verdict", { ...responseData, verdict: "unexpected" }],
    ["非物件", "原始文字"],
    ["null", null],
  ])("%s 不產生摘要，交回逐項呈現", (_name, data) => {
    expect(summarizeFactCheck(data)).toBeNull();
  });

  it("型別不符的欄位保留在其餘欄位中，不默默隱藏", () => {
    const summary = summarizeFactCheck({
      verdict: "mixed",
      factuality: "0.5",
      confidence: 0.4,
      feedback: null,
      related_checks: "非陣列",
    });
    expect(summary?.assessment).toBeNull();
    expect(Object.keys(summary?.rest ?? {})).toEqual(["factuality", "feedback", "related_checks"]);
  });
});

describe("結果欄摘要版面（SSR，不使用瀏覽器自動化）", () => {
  it("依序呈現判斷結果、評估文字、查核說明、來源，安全分類與流程資訊殿後", async () => {
    const html = await render(responseData);
    expect(html).toMatch(/<button[^>]*class="download-markdown"[^>]*>.*下載 Markdown.*<\/button>/s);
    const order = [
      "證據大致支持",
      "mostly_supported",
      "非常不肯定，此陳述大致為真",
      "查核說明",
      "查核來源",
      "社群人工查核",
      "流程狀態與其他欄位",
      "安全分類",
      "test-request-id",
    ].map((token) => {
      const index = html.indexOf(token);
      expect(index, token).toBeGreaterThan(-1);
      return index;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("0.123456789");
    expect(html).toContain("0.7");
    expect(html).toContain("&lt;script&gt;測試文字&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("來源清單保留 Cofacts 原文與去重後的引用連結，完整欄位可展開", async () => {
    const html = await render(responseData);
    expect(html).toContain("查核來源完整欄位");
    const [compact, details] = html.split("查核來源完整欄位");
    expect(compact.match(/href="https:\/\/cofacts.tw\/article\/example"/g)).toHaveLength(2);
    expect(compact.match(/href="https:\/\/example.org\/source"/g)).toHaveLength(1);
    expect(compact).toContain('href="https://example.org/another"');
    expect(details).toContain("12.3456789");
    expect(details).toContain("0.987654321");
  });

  it("危險網址不產生連結，僅保留純文字", async () => {
    const html = await render({
      ...responseData,
      related_checks: [
        { type: "cofacts_ai", text: "回覆", url: "javascript:alert(1)", reference_url: "data:x" },
      ],
    });
    expect(html).not.toContain("href=");
    expect(html).toContain("查核回覆");
  });

  it("沒有相關查核來源時如實說明", async () => {
    const html = await render({ ...responseData, related_checks: [] });
    expect(html).toContain("本次沒有取得相關查核來源");
    expect(html).not.toContain("查核來源完整欄位");
  });

  it("blocked 與錯誤回應退回逐項呈現", async () => {
    const blocked = await render({
      status: "blocked",
      moderation: { decision: "block", categories: ["privacy"] },
      factuality: null,
      confidence: null,
      verdict: null,
      related_checks: [],
    });
    expect(blocked).not.toContain("result-summary");
    expect(blocked).toContain("安全層停止查核");
    expect(blocked).toContain("null（沒有值，並非 0）");
    const error = await render({ status: "error", error: "INVALID_INPUT", message: "測試" });
    expect(error).not.toContain("result-summary");
    expect(error).toContain("INVALID_INPUT");
  });
});
