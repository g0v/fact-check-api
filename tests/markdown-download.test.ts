import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createFactCheckMarkdown,
  downloadFactCheckMarkdown,
  factCheckMarkdownFilename,
} from "../src/client/fact-check-markdown";

const result = {
  text: "# 測試主張 <script>alert(1)</script>",
  url: "https://example.org/background",
  status: "partial",
  moderation: { decision: "review", categories: ["privacy"], reason: "保留查核例外。" },
  factuality: 0.7,
  confidence: 0.4,
  verdict: "mostly_supported",
  feedback: "第一行\n- 第二行 <b>補充</b>",
  related_checks: [
    {
      type: "cofacts_human",
      text: "人工回覆內容",
      url: "https://cofacts.tw/article/example",
      reference_url: "https://example.org/source",
      reference_urls: ["https://example.org/source", "https://example.org/another"],
      classification: "NOT_RUMOR",
      retrieval_score: 12.345,
      relevance_score: 0.987,
    },
  ],
  meta: {
    request_id: "test-request-id",
    cofacts_candidates: 15,
    cofacts_relevant: 1,
    cofacts_human_checks: 1,
    cofacts_ai_checks: 0,
    url_context_used: true,
    no_relevant_evidence: false,
    cache: { status: "miss" },
    warnings: [{ stage: "url", code: "UPSTREAM_UNAVAILABLE" }],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("查核結果 Markdown 下載", () => {
  it("依主張、判斷、說明、來源與流程資訊分段，並附完整 API 回應", () => {
    const markdown = createFactCheckMarkdown(result);
    expect(markdown).not.toBeNull();
    for (const heading of [
      "# 事實查核結果",
      "## 待查核主張",
      "## 判斷結果",
      "## 查核說明",
      "## 查核來源",
      "## 流程資訊",
      "## 完整 API 回應",
    ])
      expect(markdown).toContain(heading);
    expect(markdown).toContain("- 判斷：證據大致支持（mostly_supported）");
    expect(markdown).toContain("- 支持度（factuality）：0.7");
    expect(markdown).toContain("- 信心（confidence）：0.4");
    expect(markdown).toContain("[開啟來源](https://cofacts.tw/article/example)");
    expect(markdown).toContain("- 搜尋排序分數（retrieval score）：12.345");
    expect(markdown).toContain("- 語意相關分數（relevance score）：0.987");
    expect(markdown).toContain("- 流程狀態：部分完成（partial）");
    expect(markdown).toContain("- 安全分類：保留旗標並繼續（review）");
    expect(markdown).toContain("取得網址背景（url） · UPSTREAM\\_UNAVAILABLE");
    expect(markdown).toContain("```json");
  });

  it("在可渲染段落跳脫 Markdown 與 HTML，引用網址去重", () => {
    const markdown = createFactCheckMarkdown(result)!;
    const readableReport = markdown.split("## 完整 API 回應")[0];
    expect(readableReport).toContain("> \\# 測試主張 \\<script\\>alert(1)\\</script\\>");
    expect(readableReport).toContain("> \\- 第二行 \\<b\\>補充\\</b\\>");
    expect(readableReport.match(/https:\/\/example.org\/source/g)).toHaveLength(1);
  });

  it("無來源時明確標示，非完整查核結果不提供 Markdown", () => {
    expect(createFactCheckMarkdown({ ...result, related_checks: [] })).toContain(
      "本次沒有取得相關查核來源。",
    );
    expect(createFactCheckMarkdown({ status: "error", message: "錯誤" })).toBeNull();
  });

  it("優先以 request ID 命名，缺少時使用 UTC 時間", () => {
    expect(factCheckMarkdownFilename(result)).toBe("fact-check-test-request-id.md");
    expect(
      factCheckMarkdownFilename({ ...result, meta: {} }, new Date("2026-09-07T12:34:56.789Z")),
    ).toBe("fact-check-2026-09-07T12-34-56Z.md");
  });

  it("建立 Markdown Blob、觸發下載並回收 object URL", () => {
    const anchor = {
      href: "",
      download: "",
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fact-check");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    expect(downloadFactCheckMarkdown(result)).toBe(true);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchor).toMatchObject({
      href: "blob:fact-check",
      download: "fact-check-test-request-id.md",
      hidden: true,
    });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fact-check");
  });
});
