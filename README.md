# Fact Check API

> 以 Cloudflare Workers 與 Hono 建立的事實查核 API MVP。

本專案接受一段待查核的事實主張，先經過內容安全分類，再從 Cofacts 找出可能相關的既有查核資料，使用語意模型篩選真正相關的證據，最後由 Gemma 綜整證據並輸出查核結果。

MVP 程式已實作於 `src/api`，保留既有 Vue SSR。一般測試以模擬上游驗證完整流程；真實 Cofacts／模型語意驗收與部署驗收需另行執行。詳見 [API 維護指南](./src/api/README.md)。

## MVP pipeline

```text
Client
  │
  ▼
Hono /api/fact-check
  │
  ▼
Input validation
  │
  ▼
OpenRouter: gpt-oss-safeguard-20b
  │
  ├─ block → 回傳 blocked response
  │
  └─ allow / review
       ├─ Cofacts moreLikeThis（候選 Top 15）
       └─ optional URL safe fetch
                │
                ▼
       Workers AI: @cf/openai/gpt-oss-20b
       semantic relevance filter（保留 Top 3～5）
                │
                ▼
       Cofacts detailed evidence
       human replies / AI replies / references
                │
                ▼
       Workers AI: @cf/google/gemma-4-26b-a4b-it
       evidence synthesis
                │
                ▼
       factuality / confidence / verdict / feedback
```

模型職責刻意分離：

| 階段      | 服務                                       | 職責                                       |
| --------- | ------------------------------------------ | ------------------------------------------ |
| Safety    | OpenRouter `openai/gpt-oss-safeguard-20b`  | 判斷內容是否允許進入查核流程               |
| Retrieval | Cofacts `moreLikeThis`                     | 以高 recall 找出可能相關文章               |
| Reranking | Workers AI `@cf/openai/gpt-oss-20b`        | 判斷候選文章是否與主張實質相關；不判定真假 |
| Evidence  | Cofacts GraphQL                            | 取得通過初篩文章的人工與 AI 查核資料       |
| Synthesis | Workers AI `@cf/google/gemma-4-26b-a4b-it` | 根據整理後的證據產生最終判斷               |

## API

提供 `/health` 與 `/api/fact-check`，GET／POST 共用同一個查核流程。

### `GET /health`

```json
{
  "status": "ok"
}
```

### `GET /api/fact-check`

```http
GET /api/fact-check?text=非學校型態學生，國中小以下目前沒有普遍補助
GET /api/fact-check?text=...&url=https%3A%2F%2Fexample.com%2Farticle
```

### `POST /api/fact-check`

```http
POST /api/fact-check
Content-Type: application/json
```

```json
{
  "text": "非學校型態學生，國中小以下目前沒有普遍補助",
  "url": "https://civic.vtaiwan.tw/issues/7"
}
```

`text` 必填，會先 trim 並檢查最多 10,000 字；`url` 選填，僅接受 `http` / `https`。GET 與 POST 最終共用同一個 `factCheck()` service。

輸入錯誤的格式：

```json
{
  "status": "error",
  "error": "INVALID_INPUT",
  "message": "text 必填且不得超過 10,000 字；url 選填且須為公開 HTTP／HTTPS 網址。"
}
```

### 回應欄位（示例）

```json
{
  "text": "非學校型態學生，國中小以下目前沒有普遍補助",
  "url": "https://civic.vtaiwan.tw/issues/7",
  "status": "completed",
  "moderation": {
    "decision": "allow",
    "categories": []
  },
  "factuality": 0.9,
  "confidence": 0.82,
  "verdict": "mostly_supported",
  "related_checks": [],
  "feedback": "根據目前整理到的證據，這項主張大致成立，但仍需注意適用範圍。",
  "meta": {
    "cofacts_candidates": 15,
    "cofacts_relevant": 3,
    "cofacts_human_checks": 2,
    "cofacts_ai_checks": 1
  }
}
```

`verdict` 的固定值為：

```text
supported
mostly_supported
mixed
mostly_refuted
refuted
insufficient_evidence
```

`factuality` 表示主張獲證據支持的程度（`0`～`1`）；`confidence` 表示證據是否充分、可靠且一致。兩者不可混為一談，例如高 factuality 仍可能搭配低 confidence。

## 證據與模型分工原則

- Cofacts 的 Elasticsearch `_score` 只是搜尋排序 metadata，不是百分比、機率、相關度或 factuality。
- `retrievalScore`（Cofacts `_score`）與 `relevanceScore`（語意初篩結果）必須分開保存。
- `gpt-oss-20b` 只做 relevance filter，不負責判斷真假。
- 先以 Cofacts Retrieval 取約 15 筆候選，再批次篩選，最多只對 3～5 筆取得詳細 evidence。
- 人工查核回覆與 Cofacts AI 回覆必須分開；人工查核及其引用來源優先於 AI 回覆。
- 沒有相關 Cofacts 資料不是錯誤；沒有 URL 時，最終結果應傾向 `insufficient_evidence`，不能靠模型記憶補足證據。
- 使用者提供的 URL 只是 context，不自動代表可信來源。

## 安全與錯誤處理

Safety Gate 至少涵蓋仇恨／去人化、騷擾、人身攻擊、露骨性內容、暴力威脅與隱私曝露；引用、新聞、公共政策討論、學術研究及批判性分析仍應保留 fact-check exception。

提供 URL 時，fetcher 必須：

- 只接受 `http` / `https`。
- 阻擋 localhost、loopback、private network 與 link-local 位址。
- 每次 redirect 後重新進行 SSRF 檢查。
- 設定 timeout、response size limit 與 content-type validation。

上游服務失敗時：

| 階段             | 行為                                         |
| ---------------- | -------------------------------------------- |
| Safeguard        | 回傳 `502`，不可跳過安全層                   |
| Cofacts search   | 若有 URL 可繼續，但標記 upstream unavailable |
| Relevance filter | 不把未篩選候選直接送給 Gemma                 |
| Cofacts detail   | 單筆失敗可跳過，保留其他 evidence            |
| URL fetch        | Cofacts 流程照常進行                         |
| Gemma synthesis  | 回傳 `502`，不可自行拼接 factuality          |

## 設定

### 必要條件

- Node.js 與 npm
- Cloudflare 帳號（部署及 Workers AI binding）
- OpenRouter API key

MVP 唯一需要設定的 secret 是 `OPENROUTER_API_KEY`。Cofacts 使用公開 GraphQL API，不需要 app ID 或 app secret；Workers AI 透過 Worker 的 `env.AI` binding 使用，不需要另外設定 Cloudflare AI API key。

本機開發時，在 `.dev.vars` 放入：

```dotenv
OPENROUTER_API_KEY=your-openrouter-api-key
```

部署至 Cloudflare 時：

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

請勿將真實 credential 寫入 README、提交至 Git，或放進 production log。`.dev.vars` 已列入 `.gitignore`。

`wrangler.jsonc` 需要包含 Workers AI binding：

```jsonc
{
  "name": "fact-check",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-17",
  "ai": { "binding": "AI" },
}
```

Workers AI binding 已設定；為配合目前安裝的 workerd，保留既有 compatibility date。實際部署設定以 repository 內的 `wrangler.jsonc` 為準。建置不讀取或複製本機 secret。

## 開發

```bash
vp install        # 安裝依賴
vp run dev        # 啟動本機 Vite / Worker 開發環境
vp run check      # 格式與 lint 檢查
vp run typecheck  # TypeScript 型別檢查
vp run build      # 建置
vp test           # 執行測試
vp run deploy     # 建置並部署至 Cloudflare Workers
```

本機 health check：

```bash
curl http://localhost:5173/health
```

## 目錄結構

```text
src/
├── index.ts                 # Hono 主程式與 SSR
├── api/
│   ├── index.ts             # API middleware 與錯誤處理
│   ├── config.ts            # 模型、門檻、大小與時間限制
│   ├── routes/
│   ├── services/            # 各階段與 orchestrator
│   ├── prompts/
│   ├── schemas/
│   ├── types/
│   ├── utils/
│   └── README.md            # 維護契約與驗收方式
├── views/
├── components/
└── ssr/
```

## 測試與驗收

第一個 regression fixture 已放在 `tests/fixtures/relevance-cases.json`，至少確認以下案例的語意篩選結果：

- 與「國中小非學校型態教育補助」直接相關的 Cofacts 文章 → `relevant`
- 只談國中小性教育、停班停課、同志教育或公投的文章 → `irrelevant`

MVP 驗收條件包括：Safeguard、Cofacts retrieval、批次 relevance filter、詳細 evidence、human/AI evidence 分流、Gemma synthesis、安全 URL fetch、明確的 upstream fallback，以及 end-to-end 測試。

## 相關文件

- [MVP 工程施工藍圖](./design/fact_check_MVP_plan.md)
- [MIT License](./LICENSE)

## License

MIT。

## 呼叫與部分失敗

Vite 預設網址如下；若連接埠被占用，以啟動訊息為準。

```bash
curl --get 'http://localhost:5173/api/fact-check' --data-urlencode 'text=非學校型態學生，國中小以下目前沒有普遍補助'
curl 'http://localhost:5173/api/fact-check' -H 'Content-Type: application/json' --data '{"text":"非學校型態學生，國中小以下目前沒有普遍補助"}'
```

回應可能為 `completed`、`partial` 或 `blocked`。`partial` 的原因在 `meta.warnings`；`blocked` 回 HTTP 200，factuality、confidence、verdict 為 null。Safeguard／Gemma 失敗回 502；搜尋／初篩失敗時，只有 URL 文字已成功取得才繼續。所有回應禁止快取並附 request ID。

模型、URL 安全邊界、真實語意回歸指令與已知限制請見 [API 維護指南](./src/api/README.md)。
