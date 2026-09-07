# Fact Check API

以 Cloudflare Workers、Hono 與 Vue SSR 建立的事實查核 API MVP。送入一段待查核文字與選填網址，取得相關查核、證據綜整與結構化 JSON 結果。

首頁 `/` 提供可操作的查核表單，以同源 POST 呼叫 `/api/fact-check`。輸入待查核文字與選填網址後，逐項顯示 API 回傳值及中文含義，包含安全分類、原始分數、相關查核、來源連結、流程警告與錯誤，也可展開完整原始回應。分數不換算成百分比，`null`、空陣列及未知欄位均保留。

原有繁體中文 API 使用指南、可複製的呼叫範例、參數與錯誤處理仍保留。表單需要 JavaScript；`src/client/home.ts` 只啟用表單區塊，Vite 在開發時提供此入口，建置時產生 `dist/client/assets/home.js`，其餘頁面維持 SSR。

## 快速開始

需要 Node.js、npm、Vite+（`vp`）、Cloudflare 帳號與 OpenRouter API key。

```bash
vp install
```

自行建立本機 `.dev.vars`，設定唯一必要 secret：

```dotenv
OPENROUTER_API_KEY=your-openrouter-api-key
```

請勿提交真實金鑰。`wrangler.jsonc` 已設定 Workers AI 的 `AI` binding；本機呼叫模型仍需要可連線的 Cloudflare 帳號與額度。Cofacts 使用公開 GraphQL，不需要 app ID／secret，也不必另外設定 Cloudflare AI API key。

```bash
vp run dev
```

開啟啟動訊息中的網址，預設為 `http://localhost:5173`。首頁與 `/health` 可用，不代表外部模型及資料來源已通過連線驗收。

## 呼叫 API

| 方法 | 路徑              | 用途                               |
| ---- | ----------------- | ---------------------------------- |
| GET  | `/`               | API 使用說明首頁                   |
| GET  | `/health`         | 回傳 `{"status":"ok"}`，不呼叫上游 |
| GET  | `/api/fact-check` | 以 query string 傳入參數           |
| POST | `/api/fact-check` | 限本站同源前端，以 JSON 傳入參數   |

以下指令使用本機網址；部署後請替換為你的服務位址。

### POST：本站前端以 JSON 查核

POST 只接受與本站完全相同的 `Origin`（協定、主機、連接埠均須相同）。請在本站前端使用相對網址，瀏覽器會自動附上 Origin：

```javascript
const response = await fetch("/api/fact-check", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    text: "非學校型態學生，國中小以下目前沒有普遍補助",
  }),
});
const result = await response.json();
console.log(result);
```

跨來源、缺少 Origin、`Origin: null` 都回 HTTP 403／`FORBIDDEN_ORIGIN`，且不進入查核流程。此端點的 OPTIONS 預檢也回 403，不回傳 `Access-Control-Allow-*` 標頭；同源瀏覽器呼叫不需要 CORS 預檢。

這是瀏覽器來源限制，不是身分驗證；非瀏覽器程式可自行設定 Origin。GET 仍保留原有公開呼叫行為。CORS 的作用範圍見 [MDN 說明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)。

本機維護測試若使用 curl，需明確帶入與目標位址一致的 Origin：

```bash
curl 'http://localhost:5173/api/fact-check' \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: application/json' \
  --data '{"text":"非學校型態學生，國中小以下目前沒有普遍補助"}'
```

可在 JSON 加入選填的 `url`：

```json
{
  "text": "非學校型態學生，國中小以下目前沒有普遍補助",
  "url": "https://civic.vtaiwan.tw/issues/7"
}
```

### GET：以參數查核

```bash
curl --get 'http://localhost:5173/api/fact-check' \
  --data-urlencode 'text=非學校型態學生，國中小以下目前沒有普遍補助'
```

附帶網址：

```bash
curl --get 'http://localhost:5173/api/fact-check' \
  --data-urlencode 'text=非學校型態學生，國中小以下目前沒有普遍補助' \
  --data-urlencode 'url=https://civic.vtaiwan.tw/issues/7'
```

`--data-urlencode` 會處理中文、空白及特殊字元。內容較長或敏感時建議使用 POST，避免文字出現在網址歷史或 access log。OpenRouter 金鑰只由服務維運者設定，不放進用戶端請求。

### 輸入限制

| 欄位   | 必填 | 說明                                                                            |
| ------ | ---- | ------------------------------------------------------------------------------- |
| `text` | 是   | 字串，trim 後不可為空，最多 10,000 個 Unicode code point                        |
| `url`  | 否   | 公開 HTTP／HTTPS 網址，最多 2,048 個 UTF-16 code unit，不可帶帳號密碼或指向內網 |

POST 的 `Content-Type` 必須為 `application/json`，本文上限為 128,000 bytes。沒有網址時省略 `url`，不接受空字串或 `null`。

URL 只提供背景，不自動視為可信來源。抓取支援 HTML 與純文字，不執行網頁 JavaScript；失敗時保留警告，Cofacts 流程照常。

## 回應格式

下列為「查無相關查核資料，改以常識判斷」的格式示例，並非對範例主張的實際查核結果。

```json
{
  "text": "非學校型態學生，國中小以下目前沒有普遍補助",
  "status": "completed",
  "moderation": {
    "decision": "allow",
    "categories": []
  },
  "factuality": 0.7,
  "confidence": 0.4,
  "verdict": "mostly_supported",
  "related_checks": [],
  "feedback": "查無相關查核資料，以下為常識判斷：此主張與常見制度描述大致相符，請自行查證。",
  "meta": {
    "request_id": "example-request-id",
    "cofacts_candidates": 0,
    "cofacts_relevant": 0,
    "cofacts_human_checks": 0,
    "cofacts_ai_checks": 0,
    "url_context_used": false,
    "no_relevant_evidence": true,
    "warnings": []
  }
}
```

若輸入有 `url`，回應也會保留該欄位。查核回應附有 `X-Request-Id` 與 `Cache-Control: no-store`。

| 欄位             | 意義                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------ |
| `factuality`     | 0～1，證據支持主張的程度，不是主張為真的機率；查無證據時表示依常識判斷主張為真的程度 |
| `confidence`     | 0～1，判斷所依據的證據是否充分、可靠且一致；查無證據時由程式下修至最高 0.5           |
| `verdict`        | 下表列出的固定判斷分類                                                               |
| `feedback`       | 繁體中文說明，包含適用範圍、證據限制與查證方向                                       |
| `related_checks` | 相關人工／AI 查核及其來源連結                                                        |
| `meta`           | request ID、候選／證據數量、URL 背景使用狀態、`no_relevant_evidence` 旗標與警告      |

| verdict                 | 意義                 |
| ----------------------- | -------------------- |
| `supported`             | 證據支持             |
| `mostly_supported`      | 證據大致支持         |
| `mixed`                 | 支持與反駁的證據並存 |
| `mostly_refuted`        | 證據大致反駁         |
| `refuted`               | 證據反駁             |
| `insufficient_evidence` | 證據不足，無法判定   |

`related_checks` 每筆以 `type` 區分 `cofacts_human`／`cofacts_ai`，保留 `text` 與 Cofacts article `url`，有引用來源時附 `reference_url`／`reference_urls`；其他 metadata 包含 `classification`、`retrieval_score` 與 `relevance_score`。

Cofacts 的 `retrieval_score` 只是搜尋排序，不是百分比、機率或相關度；`relevance_score` 才是語意相關程度。兩者都不是真假判斷，不可直接換算 factuality。

## 相同問題的 Worker 快取

GET／POST 通過原有驗證後，共用 Worker 端的查核結果快取，預設保留 **1 小時**。文字去除首尾空白、網址經 API 正規化後完全相同才會命中；換網址或修改內文會重新查核。只儲存 `completed` 且沒有警告的結果，包括「查無相關資料的常識判斷」；`partial`、`blocked` 與錯誤不儲存。

命中時重用原有安全分類、證據與模型結果，不重新呼叫上游；`X-Request-Id` 與 `meta.request_id` 仍是本次的新識別碼。`Cache-Control: no-store` 保持不變，瀏覽器不儲存查核回應。Worker 快取與瀏覽器快取分開管理。

| `X-Fact-Check-Cache` | `meta.cache.status` | 意義                                                                      |
| -------------------- | ------------------- | ------------------------------------------------------------------------- |
| `HIT`                | `hit`               | 已重用快取；另附 `cached_at` 與 `expires_at`（UTC），首頁會顯示中文說明。 |
| `MISS`               | `miss`              | 未取得可用快取，執行本次查核；不代表一定已成功寫入快取。                  |
| `BYPASS`             | `bypass`            | 快取服務未提供或無法開啟，照常執行查核。                                  |

手動驗證時，可在首頁送出完全相同的文字與網址兩次，預期第二次出現 `hit`。寫入由 `waitUntil` 在背景執行，極短時間內重送、不同資料中心或快取被提早移除時，仍可能重新查核。不需新增 KV binding 或 secret。

快取是資料中心內的儲存，不保證跨地點命中；行為依 [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) 而定。TTL、命名空間與版本設定見 `src/api/config.ts` 的 `RESULT_CACHE`，實作與限制見 [API 維護指南](./src/api/README.md#worker-查核結果快取)。

## 狀態與錯誤

HTTP 200 時仍需檢查 `status`：

| status      | 行為                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| `completed` | 流程完成，可能得到證據不足的判斷                                                   |
| `partial`   | 部分上游失敗，以仍可取得的證據完成綜整；原因見 `meta.warnings`                     |
| `blocked`   | 安全層停止查核；factuality、confidence、verdict 為 `null`，related_checks 為空陣列 |

安全分類 `allow`／`review` 都繼續處理，`review` 保留旗標。引用待查言論、新聞、公共政策、學術研究與批判性分析等情境會納入查核例外考量。

錯誤回應示例：

```json
{
  "status": "error",
  "error": "INVALID_INPUT",
  "message": "text 必填且不得超過 10,000 字；url 選填且須為公開 HTTP／HTTPS 網址。",
  "request_id": "example-request-id"
}
```

| HTTP | error                  | 處理方式                                                      |
| ---- | ---------------------- | ------------------------------------------------------------- |
| 400  | `INVALID_INPUT`        | 修正文字、網址、JSON 格式或請求大小；請求讀取逾時亦會回此錯誤 |
| 403  | `FORBIDDEN_ORIGIN`     | POST 來源不符本站、未提供 Origin，或發送不支援的 OPTIONS 預檢 |
| 413  | `PAYLOAD_TOO_LARGE`    | 已宣告的本文過大，縮短內容後重試                              |
| 502  | `UPSTREAM_UNAVAILABLE` | 必要上游無法使用；回應另附 `stage`，可稍後重試                |
| 500  | `INTERNAL_ERROR`       | 提供 request ID 協助排查                                      |

Safeguard 或 Gemma 失敗回 502，不跳過安全層、不自行拼湊分數。Cofacts 搜尋或語意初篩失敗時，只有已成功取得 URL 文字才繼續並標記 partial，否則回 502。單篇詳細證據或 URL 抓取失敗時，保留其他資料與警告。

## 查核流程

| 階段     | 服務                                       | 職責                                                     |
| -------- | ------------------------------------------ | -------------------------------------------------------- |
| 安全分類 | OpenRouter `openai/gpt-oss-safeguard-20b`  | 決定是否進入查核流程                                     |
| 候選搜尋 | Cofacts `moreLikeThis`                     | 召回最多 15 篇文章；此時平行抓取選填 URL                 |
| 語意初篩 | Workers AI `@cf/openai/gpt-oss-20b`        | 批次判斷相關性，最多保留 5 篇，不判真假                  |
| 詳細證據 | Cofacts `GetArticle`                       | 只取相關文章的人工／AI 查核與來源，分開保存              |
| 證據綜整 | Workers AI `@cf/google/gemma-4-26b-a4b-it` | 依據證據產生 factuality、confidence、verdict 與 feedback |

初篩門檻為 `relevant: true` 且 `relevance >= 0.5`，仍須以實測 dataset 校準。沒有相關 Cofacts 資料不是錯誤；完全沒有證據時，Gemma 在同一輪 prompt 改用一般常識給出有意義的判斷，程式以 `meta.no_relevant_evidence` 標記並把 `confidence` 下修至最高 0.5，常識也無法判斷時才回 `insufficient_evidence`。

## 開發與驗證

```bash
vp run check      # 格式與 lint 檢查
vp run build      # 建置
vp test           # 執行測試
vp run typecheck  # TypeScript 型別檢查
```

一般測試模擬外部傳輸，原生 HTML 解析以本機 workerd 執行。`tests/fixtures/relevance-cases.json` 保存藍圖的四個 Cofacts ID 與標註；一般回歸測試驗證處理邏輯，不代表真實模型已通過語意驗收。

需要網路與已登入的 Cloudflare 帳號，才啟用真實語意回歸：

```bash
FACT_CHECK_LIVE=1 vp test tests/relevance.live.test.ts
```

此測試會使用 Workers AI 額度。完整正式服務連線與部署驗收需另行執行。

確認部署時，在 Cloudflare 設定相同名稱的 secret，再執行部署：

```bash
npx wrangler secret put OPENROUTER_API_KEY
vp run deploy
```

`wrangler.jsonc` 保留目前 workerd 相容的 compatibility date；建置不讀取或複製本機 secret。URL DNS rebinding、抓取編碼及模型 timeout 等邊界請見 [API 維護指南](./src/api/README.md)。

## 目錄與文件

```text
src/
├── index.ts                 # 掛載 API、首頁與既有 SSR 路由
├── api/
│   ├── index.ts             # middleware 與錯誤回應
│   ├── config.ts            # 模型、門檻與資源限制
│   ├── routes/
│   ├── middleware/          # POST 同源 Origin 檢查
│   ├── services/            # 各查核階段與 orchestrator
│   ├── prompts/
│   ├── schemas/
│   ├── types/
│   ├── utils/
│   └── README.md            # API 維護指南
├── views/Home.vue           # API 使用說明首頁
├── components/NavBar.vue    # 共用導覽
└── ssr/                     # Vue SSR 與頁面 metadata
public/                      # 共用樣式與 favicon
tests/                       # API、SSR、原生 HTML 與語意回歸測試
```

- [MVP 工程施工藍圖](./design/fact_check_MVP_plan.md)
- [API 維護指南](./src/api/README.md)
- [議題 #6：建立首頁](https://github.com/g0v/fact-check-api/issues/6)

## 授權

程式碼採 [MIT License](./LICENSE)。
