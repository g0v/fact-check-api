import { expect, it } from "vite-plus/test";
import { getPlatformProxy } from "wrangler";
import type { ApiBindings } from "../src/api/types/fact-check";
import { queryCofacts } from "../src/api/services/cofacts-client";
import { filterRelevantCandidates } from "../src/api/services/relevance-filter";
import { record, string } from "../src/api/utils/validation";
import educationFixture from "./fixtures/relevance-cases.json";
import historyFixture from "./fixtures/relevance-history-cases.json";

// 明確啟用才呼叫正式服務；不用 OpenRouter secret，也不讀取本機 secret 檔。
it.skipIf(process.env.FACT_CHECK_LIVE !== "1").each([
  { name: "自學補助", fixture: educationFixture },
  { name: "治理歷史與不同立場的相關背景", fixture: historyFixture },
])(
  "真實 Cofacts 原文與 Workers AI 的語意回歸：$name",
  async ({ fixture }) => {
    const proxy = await getPlatformProxy<ApiBindings>({
      configPath: "wrangler.jsonc",
      envFiles: ["tests/fixtures/no-secrets.vars"],
      persist: false,
      remoteBindings: true,
    });
    try {
      const candidates = await Promise.all(
        fixture.candidates.map(async (item) => {
          const data = await queryCofacts(
            "query Fixture($id: String!) { GetArticle(id: $id) { id text } }",
            { id: item.id },
            fetch,
          );
          const article = record(data.GetArticle);
          return {
            articleId: string(article.id),
            text: string(article.text, 1_000_000),
            searchScore: null,
          };
        }),
      );
      const result = await filterRelevantCandidates(fixture.claim, candidates, proxy.env);
      for (const item of fixture.candidates) {
        expect(
          result.selected.some((selected) => selected.articleId === item.id),
          item.reason,
        ).toBe(item.expected);
      }
    } finally {
      await proxy.dispose();
    }
  },
  120_000,
);

it.skipIf(process.env.FACT_CHECK_LIVE !== "1")(
  "真實模型保留直接支持與反駁主張的文章",
  async () => {
    const proxy = await getPlatformProxy<ApiBindings>({
      configPath: "wrangler.jsonc",
      envFiles: ["tests/fixtures/no-secrets.vars"],
      persist: false,
      remoteBindings: true,
    });
    try {
      // 虛構地名與事件，專門驗證語意比對，不依賴模型的世界知識。
      const candidates = [
        { articleId: "support", text: "星河市第一座圖書館於 2010 年開幕。", searchScore: null },
        {
          articleId: "refute",
          text: "星河市在 2010 年尚無圖書館，第一座直到 2018 年才開幕。",
          searchScore: null,
        },
        { articleId: "topic-only", text: "星河市市長喜歡閱讀科幻小說。", searchScore: null },
      ];
      const result = await filterRelevantCandidates(
        "星河市第一座圖書館在 2010 年開幕。",
        candidates,
        proxy.env,
      );
      expect(result.selected.map((item) => item.articleId).sort()).toEqual(["refute", "support"]);
    } finally {
      await proxy.dispose();
    }
  },
  120_000,
);
