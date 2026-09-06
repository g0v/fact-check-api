# 查核 API 維護指南

本目錄實作 [工程藍圖](../../design/fact_check_MVP_plan.md) 與 [議題 #5](https://github.com/g0v/fact-check-api/issues/5)。主程式只負責掛載 API 與 `/health`，Vue SSR 保持獨立。

## 閱讀順序

1. `index.ts`：request ID、禁止瀏覽器快取、統一錯誤回應。
2. `routes/fact-check.ts`：GET／POST 共用輸入驗證及 `cachedFactCheck()`；`middleware/same-origin.ts` 在讀取 POST 本文前檢查 Origin。
3. `services/fact-check.ts`：完整流程、平行工作與部分失敗策略。
4. `services/`：安全分類、候選搜尋、批次初篩、詳細證據、URL 背景、Gemma 綜整。
5. `prompts/`、`schemas/`、`types/`：模型職責、輸入輸出契約與資料型別。
6. `config.ts`：模型名稱、門檻、文字及時間限制。

## 已確認的 MVP 契約

- `text` trim 後必填，最多 10,000 個 Unicode code point；URL 最長 2,048 個 UTF-16 code unit。
- POST 的 Origin 必須與請求 URL 的 origin 完全一致；跨來源、缺少 Origin 或 `Origin: null` 回 HTTP 403／`FORBIDDEN_ORIGIN`，不呼叫上游。此端點的 OPTIONS 也回 403，不提供跨來源 CORS 授權。
- POST 必須為 JSON；body 最多 128,000 bytes。URL 選填，拒絕空字串、非 HTTP／HTTPS、內網位址及帶帳號密碼的網址。
- `allow`／`review` 繼續，`review` 留在 moderation 中；`block` 回 HTTP 200、`status: blocked`，分數與 verdict 為 `null`，不執行下游。
- 正常回 HTTP 200、`status: completed`；有可恢復的上游失敗則回 HTTP 200、`status: partial`，原因在 `meta.warnings`。
- 每次回應有 `X-Request-Id` 與 `Cache-Control: no-store`。API 錯誤含繁體中文 message、固定英文 error code 與 request ID。

| 失敗階段                  | 行為                                                            |
| ------------------------- | --------------------------------------------------------------- |
| Safeguard                 | HTTP 502，不略過安全層                                          |
| Cofacts search／relevance | 已成功抓到 URL 文字才以 URL 繼續並標記 partial，否則 HTTP 502   |
| Cofacts detail            | 單筆文章失敗跳過，記錄文章 ID，其他證據繼續                     |
| URL                       | 保留警告，Cofacts 照常；搜尋成功但沒有證據時交 Gemma 回證據不足 |
| Gemma／模型 JSON 驗證     | HTTP 502，不自行生成替代分數                                    |

## Safeguard 呼叫契約

`cachedFactCheck()` 未命中時才執行以下完整查核流程；有效快取沿用當時的安全分類與證據結果。

`services/moderation.ts` 參考 `civic-talk-hono/src/moderation/service.ts` 已實測的 OpenRouter 寫法，使用 `response_format.type: "json_schema"`、`strict: true`、`reasoning: { effort: "low" }`、`max_tokens: 1600` 與 `temperature: 0`。推理 token 也會占用輸出額度；不可只調整 `max_tokens` 而忽略推理設定。

Schema 使用查核 API 的 `decision`（`allow`／`review`／`block`）、`categories`、`reason`；分類政策保留查核例外，真假判定由後續 Gemma 負責。只接受無 choice error、`finish_reason: "stop"` 且 `message.content` 為有效判定 JSON 的回應；截斷、缺少完成標記或格式錯誤一律回 HTTP 502，停止下游。

`tests/moderation.test.ts` 固定驗證請求參數與異常回應處理；使用模擬傳輸，不代表 fact-check-api 已通過真實模型實測。

### Safeguard 除錯紀錄

查核 API 預設透過 `console.info` 輸出結構化 JSON，不需另外開啟 debug 設定。用同一個 `request_id` 依序查看：

1. `request.openrouter_api_key_present`：`factCheck` 收到的 Worker binding 是否有設定值。
2. `moderation_config`：`step: "before_read"` 在讀取 binding 前輸出；`step: "after_read"` 記錄 `api_key_present`、`api_key_is_string` 與 `api_key_configured`。最後一項須為非空白字串才為 `true`；這不代表金鑰已通過 OpenRouter 驗證。
3. `moderation_request`：設定檢查通過，準備送出；包含模型名稱、timeout 與推理／輸出參數。
4. `moderation_http_response`：已收到上游 headers，包含 `upstream_status` 與當時耗時。
5. `moderation_response`：已解析上游 JSON，包含 choice 數量、`finish_reason`、content 長度、有無推理、數值錯誤碼與 token 用量。缺少或無效的數值記為 `null`；未知完成代碼記為 `unknown`。
6. `moderation_error`：失敗原因與可用的診斷欄位；原有 `stage`／API 錯誤紀錄仍保留，對外仍回 HTTP 502。

| `moderation_error.reason`                                                             | 排查方向                                                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `missing_api_key`                                                                     | Worker binding 缺少、不是字串或只有空白；請確認目前執行環境的 `OPENROUTER_API_KEY` 設定。                       |
| `network_error`／`timeout`                                                            | 請求參數、連線失敗或超過期限；`upstream_status: null` 表示尚未收到 HTTP 回應，已有狀態則可能卡在讀取本文。      |
| `http_error`                                                                          | OpenRouter 回非成功狀態；查看 `upstream_status`，例如 401、429 或 5xx。                                         |
| `response_read_error`／`response_too_large`／`invalid_response_json`                  | HTTP 回應本文讀取、大小限制或外層 JSON 格式問題。                                                               |
| `upstream_error`／`choice_error`                                                      | HTTP 成功但回應含錯誤物件；查看 `upstream_error_code`／`choice_error_code`。                                    |
| `incomplete_completion`                                                               | `finish_reason` 缺少或不是 `stop`；若為 `length`，搭配 `completion_tokens` 與 `reasoning_tokens` 檢查輸出額度。 |
| `invalid_completion`／`invalid_content`／`invalid_content_json`／`invalid_moderation` | 分別是 completion 結構、content 空白／型別／長度、content JSON 或判定 schema 問題。                             |

例如讀取後出現 `api_key_present: false`、`api_key_configured: false`，接著出現 `reason: "missing_api_key"`，代表尚未呼叫 OpenRouter。若已出現 `moderation_request`，則繼續查看 HTTP 狀態與回應診斷。僅憑舊紀錄的 1 ms 失敗尚不能判定金鑰是否缺少。

本機 `vp run dev` 由 Cloudflare 外掛交給 Wrangler 載入與 `wrangler.jsonc` 同目錄的 `.dev.vars`；Vite 的 `envDir: false` 不會停用這條載入路徑。若啟動後才建立 `.dev.vars`，請先儲存檔案，完全停止並重新執行 `vp run dev`，再確認 `api_key_configured`。目前安裝的外掛只針對設定檔的 `change` 事件重新啟動，新增檔案不一定觸發載入。若使用 `CLOUDFLARE_ENV`，也須確認對應 `.dev.vars.<環境名稱>` 是否覆蓋一般設定。

上述紀錄只包含固定訊息、布林值、數值與允許的完成代碼，不記錄金鑰值或長度、headers、使用者原文、模型 content／reasoning、上游錯誤訊息或本文。`tests/moderation-logging.test.ts` 覆蓋設定缺少、傳輸失敗、輸出驗證與紀錄隱私。

Workers 的 `fetch` 不支援 `redirect: "error"`，使用時會在連線前拋出 `TypeError`，也可能呈現為幾毫秒內的 `network_error`。共用 JSON 請求與 DNS 查詢使用 `redirect: "manual"`，再透過 `response.ok` 拒絕重新導向等非成功狀態；不自動將授權標頭送往重新導向目標。

## Worker 查核結果快取

`services/cached-fact-check.ts` 實作 [議題 #7](https://github.com/g0v/fact-check-api/issues/7)，在輸入與 Origin 驗證後、整個 pipeline 之前查詢 `caches.open("fact-check-results")`。命中時不呼叫 Safeguard、Cofacts 或 Workers AI；只有先前 `completed`、無警告且結構有效的結果可被採用。

- 預設 TTL 為 3,600 秒，另在 payload 檢查建立時間，逾期、未來時間或格式錯誤視為不可用；命中不延長期限。
- 合成 GET key 使用目前站台 origin 與 SHA-256，摘要輸入包含正規化後的 `text`、`url`、`MODELS`、`LIMITS`、三份提示及 `RESULT_CACHE.version`。GET／POST 共用，文字內部空白、標點與字形不合併。
- 模型、提示及門檻變更自動產生新 key；其他查核邏輯、輸出參數或回應契約改動時應遞增 `RESULT_CACHE.version`，避免沿用舊結果。金鑰不參與 key，不需為金鑰輪替清快取。
- 儲存內容含查核證據與綜整結果，但移除輸入回填欄位、原 request ID 與快取 metadata；命中時回填本次輸入及新的 request ID。此機制仍會在 Worker 端保留查核結果至 TTL 到期或被提早移除。
- 只有內部快取用的 Response 帶 `public, max-age=3600`。對外回應持續 `Cache-Control: no-store`，不提供讀取合成快取 URL 的公開路由。
- Worker 使用 `executionCtx.waitUntil()` 承接寫入。開啟、讀取與寫入各有 1 秒等待上限；任何快取問題不改變查核結果、不新增 `meta.warnings`，也不回傳快取例外文字。
- JSON 儲存與讀取上限沿用 `LIMITS.upstreamBytes`；過大的結果只略過快取。沒有 Cache API 的 Node 測試環境直接執行原 pipeline。
- 不做跨請求的鎖定或相同進行中請求合併；同時出現的冷快取請求可能各自呼叫模型。背景寫入尚未完成時重送亦可能 miss。

成功回應含 `X-Fact-Check-Cache: HIT/MISS/BYPASS` 與 `meta.cache.status`。命中另含 `cached_at`／`expires_at`，首頁逐項說明這些欄位；原始證據與分數不重新計算。Log 只新增 `event: "cache"`、request ID、操作（`read`／`write`／`schedule`）與狀態，不輸出 hash、原文、網址或 credential。`stored` 表示 Cache API 的寫入呼叫已完成，不保證平台一定保留到期。

[Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) 的內容不跨資料中心複寫，平台可能提早移除；Dashboard／Playground 預覽不保證可觀察命中。`tests/result-cache.test.ts` 覆蓋命中、過期、隔離、故障回退、背景寫入與同源限制；使用模擬儲存，不代表已部署驗收。

## 瀏覽器來源限制

同源依請求 URL 的協定、主機與連接埠判斷，適用部署網域及本機開發，不新增 secret 或白名單設定。不使用 Referer、Host、X-Forwarded-Host 等標頭替代 Origin，也不允許 `Origin: null`。標準 Origin 不含路徑或尾端斜線。

本站前端以相對 URL 執行 POST fetch，Origin 由瀏覽器設定；不要把金鑰放到前端。CLI 維護測試可明確提供同源 Origin，範例見 README。此限制不驗證呼叫者身分，不能防止非瀏覽器程式自行設定 Origin；GET 保持原有公開行為。

## 證據契約

候選搜尋預設取 15 筆，只查 `id`、`text`、`score`；保留 `searchScore`，不依此篩掉文章。初篩一次呼叫 `gpt-oss-20b`，每篇送入最多 3,000 個 UTF-16 code unit，不附搜尋分數。輸出必須涵蓋所有候選 ID，且不得新增或重複。只有 `relevant: true` 且 `relevance >= 0.65` 才保留，依相關性排序、最多 5 篇。

詳細資料以文章為單位平行取得。人工與 AI 回覆分別標記 `cofacts-human`／`cofacts-ai`，每篇各最多 10 則，AI 只取 `SUCCESS`。`retrievalScore` 與 `relevanceScore` 分開保存。人工 reply 的 `reference`、hyperlinks 與原始文章的 references 分開；原始訊息出處不會充當人工查核引文。

每筆 evidence 文字最多 6,000 個 UTF-16 code unit。綜整時另分配全體 evidence 共 60,000 的本文文字預算，以及各半的原始文章與引文文字預算，避免過量回覆超出 context。`related_checks` 由程式根據實際 Cofacts 證據建立，不由模型編造；每筆保留 Cofacts article URL。

Gemma 為唯一真假判斷階段。當 evidence 空陣列時，模型必須回 `insufficient_evidence`、`factuality: 0.5`、`confidence <= 0.2`；違反便回上游錯誤。這裡的 0.5 表示未能判定，不是「有一半機率為真」。各門檻仍須以真實 dataset 校準。

## URL 抓取邊界

每次目標抓取前檢查 URL 與公開 DNS 的 A／AAAA 結果；只要包含非公開位址便拒絕。使用 Cloudflare 公開 DNS-over-HTTPS，不需要額外 secret。手動處理最多 3 次 redirect，逐次重新驗證。DNS 與整個抓取／讀取流程共用 10 秒期限，body 最多 1 MB；支援 UTF-8／ASCII 的 `text/html`、`text/plain`，拒絕明示的其他編碼。

HTML 使用 Workers 原生 `HTMLRewriter` 移除腳本、樣式、樣板等內容，再解碼 HTML entities、擷取最多 12,000 個 UTF-16 code unit。網站需要 JavaScript 才產生的內容不會被執行。來源只標為 `user-provided`，不自動視為可信。

DNS 預檢與 Workers `fetch()` 是兩次解析，無法在一般 Worker fetch 中釘選任意目標 IP；DNS rebinding 的最終隔離依賴 Cloudflare 執行環境。此 fetcher 不能直接移到可存取私網的 Node 伺服器；若要部署於該環境，需改用能固定連線 IP 的出口代理。模型 binding timeout 會停止等待，但 Workers AI API 沒有在本介面提供取消推論的方法，已送出的推論仍可能計費。

## 驗證

```bash
vp run check
vp run build
vp test
vp run typecheck
```

一般測試用假的 OpenRouter／Cofacts／Workers AI 傳輸，覆蓋完整 Hono pipeline、安全 gate、門檻、錯誤 fallback、分數分離與 SSRF 邊界。HTML extraction 另外以真正的本機 workerd 執行，使用 `workerd test` 直接呼叫測試 handler，不開啟本機 HTTP socket。

`tests/http-worker.test.ts` 將實際 Safeguard 與 DNS 程式碼打包後交給 workerd，驗證原生 `fetch` 可送出請求且拒絕上游重新導向。全部 outbound 由記憶體中的假上游回應，不讀取環境檔，也不連線外部服務。

`tests/fixtures/relevance-cases.json` 保存藍圖的四個 ID 與標註；一般回歸測試只驗證模型輸出的處理邏輯，不代表模型已通過語意驗收。真實回歸會取得原文，並透過 Workers AI remote binding 呼叫模型：

```bash
FACT_CHECK_LIVE=1 vp test tests/relevance.live.test.ts
```

此指令需要網路與已登入 Cloudflare，會使用 Workers AI 額度；不使用 OpenRouter key，也不讀本機 `.dev.vars`。完整正式服務驗收則需自行設定唯一 secret `OPENROUTER_API_KEY`，啟動 `vp run dev` 後，以 README 的 GET／POST 範例查核。

## 建置與紀錄

Vite build 禁用環境檔讀取，並清除僅供 preview 複製 secret 使用的外掛 `configPath`；產物不包含本機 secret。本機開發仍由 Cloudflare 外掛在執行期載入 `.dev.vars`。

程式 log 包含 request ID、文字長度、有無 URL、安全決策、候選 ID、搜尋／相關性分數、證據數量、最終判斷及階段時間，另有上述 Safeguard 設定與回應診斷；不紀錄使用者原文、完整 URL、上游錯誤 body 或 credential。Cloudflare 平台的請求紀錄由平台設定控制；敏感查核內容建議使用 POST，以免出現在網址歷史或 access log。

## 核對來源

- [Cofacts Article schema](https://github.com/cofacts/rumors-api/blob/master/src/graphql/models/Article.js)
- [Cofacts AIResponse schema](https://github.com/cofacts/rumors-api/blob/master/src/graphql/models/AIResponse.js)
- [gpt-oss-20b binding](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Gemma binding 與 chat completion 輸出](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
- [Cloudflare Vite secret 複製行為](https://developers.cloudflare.com/workers/vite-plugin/reference/secrets/)
