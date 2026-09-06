import { expect, it } from "vite-plus/test";
import { getPlatformProxy } from "wrangler";
import type { ApiBindings } from "../src/api/types/fact-check";
import { queryCofacts } from "../src/api/services/cofacts-client";
import { filterRelevantCandidates } from "../src/api/services/relevance-filter";
import { record, string } from "../src/api/utils/validation";
import fixture from "./fixtures/relevance-cases.json";

// 明確啟用才呼叫正式服務；不用 OpenRouter secret，也不讀取本機 secret 檔。
it.skipIf(process.env.FACT_CHECK_LIVE !== "1")(
  "真實 Cofacts 原文與 Workers AI 的語意回歸",
  async () => {
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
