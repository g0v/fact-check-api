# API 維護指南

本目錄提供 Worker 的 HTTP API。查核流程不在此執行；`/api/fact-check` 由 x402 middleware 驗證逐次付款後，透過 `FACT_CHECK_CORE` service binding 呼叫獨立的 `fact-check-core` Worker。首頁使用的 `/api/demo` 保持免費，並保留來源保護、CORS 與 IP 限流。

## 閱讀順序

1. `index.ts`：request ID、`Cache-Control: no-store` 與統一錯誤回應。
2. `routes/fact-check.ts`：GET／POST 輸入驗證、GET→POST core 轉換與 x402 閘門。
3. `middleware/x402.ts`：`@x402/hono` 設定、EVM exact scheme、必要付款 vars 與 facilitator URL／認證。
4. `routes/demo.ts`：免費 facade；不要把此路由改成付費或移除 Origin guard、CORS、`ipRateLimit`。
5. `middleware/cors.ts`、`middleware/origin.ts`、`middleware/rate-limit.ts`：免費 demo 的既有守護，以及付費端點的寬鬆 CORS。
6. `services/payment-claim-do.ts`、`middleware/payment-claim.ts`：跨 isolate 的持久化原子付款 claim、authorization 識別與到期清理。
7. `types/fact-check.ts`：service binding、付款設定與 Durable Object binding 的最小型別。

## x402 閘門

付款設定由 Worker vars／secrets 注入：

- `PAY_TO`、`X402_NETWORK`、`X402_PRICE`、`FACILITATOR_URL` 都是必要設定；未設定、空字串或純空白時，GET／POST 回 `500 INTERNAL_ERROR`，不產生付款要求，也不呼叫 facilitator 或 core。
- production code 不提供收款錢包、價格、測試網或公開 facilitator 的 fallback。正式 `wrangler.jsonc` 明確使用 `eip155:8453`（Base mainnet）與 Coinbase CDP；本機測試網設定放在 `.dev.vars.example`。
- 每個請求都要重新付款，價格使用明確設定的 `X402_PRICE`。
- `FACILITATOR_AUTH_TOKEN` 是其他 facilitator 可選的固定 Bearer token。
- `CDP_API_KEY_ID`、`CDP_API_KEY_SECRET` 是 CDP Secret API Key，必須成對設定。
- `PAYMENT_CLAIM_DO` 是必要的付款防重放 binding；未綁定、呼叫失敗或回應格式錯誤時，回 `500 PAYMENT_CLAIM_UNAVAILABLE`，不進入 core。

本 API 僅支援 x402 v2。每次請求先由 middleware 建立 `PAYMENT-REQUIRED`；付款的 v2 payload 可使用 `PAYMENT-SIGNATURE`，或以 `X-PAYMENT` 作為替代標頭，後者不代表真正的 x402 v1 相容。兩個標頭同時存在時，非空的 `PAYMENT-SIGNATURE` 優先；空值才 fallback 到 `X-PAYMENT`，無效的非空值不會被替代標頭掩蓋。順序為 `verify → address reservation → atomic nonce claim → reverify → handler/core → settle → release reservation`：SDK 驗證成功後，先取得地址占位並原子認領 EIP-3009 authorization，再於占位內透過同一 facilitator 重新 verify，兩次均成功才進入 core。首次驗證失敗不占用 claim；重新驗證失敗或連線失敗回 `400 INVALID_PAYMENT` 或 `502 PAYMENT_VERIFICATION_UNAVAILABLE`，不執行 core，並嘗試釋放地址占位，但已建立的 nonce claim 仍保留。handler 回應小於 `400` 才呼叫 `settle`，成功後附上 `PAYMENT-RESPONSE`。handler 回 `>=400` 或拋例外時不走正常結算，錯誤留在原本的回應／錯誤流程。

付款身分採 `network + asset + from + nonce` 正規化後的 SHA-256；EVM 地址與 bytes32 nonce 統一小寫、chain ID 轉成十進位。付款標頭別名、JSON 排序、簽章字串、資源描述與查核本文都不影響 key，不能換一個 envelope 繞過同一 authorization 的 claim。目前付費 USDC 路由僅接受 EIP-3009；payload 必須包含 `authorization` 且不得包含 `permit2Authorization`，即使後者為 `null` 或其他假值也拒絕。純 Permit2、混合授權、無法建立防重放身分或已過期的授權均回 `400 INVALID_PAYMENT`，不建立 claim、不放行 core、不結算。

每個 key 對應一顆 `PaymentClaimDO`，在 SQLite KV transaction 中原子寫入 claim 與 alarm；不是記憶體鎖，物件回收或 Worker 重啟不會失去 claim。重複付款回 `409 PAYMENT_ALREADY_CLAIMED`，不執行 core 或 settle。claim 的 TTL 是 authorization 的 `validBefore` 加 60 秒，完整涵蓋付款效期；到期 alarm 刪除儲存，早到／舊 alarm 則依目前有效期限重新安排。

地址占位使用另一顆 `PaymentClaimDO`，key 依 `network + asset + from` 正規化後的 SHA-256 建立，與 nonce claim 的 key 分開。占位記錄授權金額、授權識別與隨機擁有者識別碼，TTL 同樣為 `validBefore` 加 60 秒。目前 facilitator 的 verify 回應不提供可信的可用餘額，因此同一餘額來源一次僅允許一筆付款，而非依推估餘額放行多筆。其他 nonce 回 `409 PAYMENT_IN_PROGRESS`，不建立其 nonce claim，可在先前付款成功結算並釋放占位後以同一授權重試。取得占位後重新 verify，避免使用另一筆結算前的過時驗證結果；不同付款地址可並行。這是本服務的並發控制，無法凍結鏈上資金，也無法阻止錢包在其他服務支出或保證後續結算成功。

nonce claim 不提供 release：同一授權只能發起一次查核嘗試。地址占位僅在 SDK 確認 settle 成功後釋放，且須匹配該次請求的隨機擁有者識別碼，避免延遲的舊釋放清除新占位。core 回錯誤、settle 失敗、結算結果不明或 Worker／core 卡死時，nonce claim 與地址占位均保留到授權到期，不採短租約。若成功結算後釋放失敗，仍交付已付款的結果，地址占位保留到到期；同地址須等待到期後再用新 nonce 重試。所有提供相同付款入口的 isolate 必須共享 `PAYMENT_CLAIM_DO` namespace；多 Worker 部署相同 paywall 時也必須共享，獨立 namespace 無法互相阻擋重放或共用餘額的並發放大。nonce claim 沿用原有 key 與資料格式，更新前建立的 claim 仍有效。

付費查核只接受 GET／POST；OPTIONS 預檢不進入付款流程。HEAD 一律回 `405 Method Not Allowed`，並附上 `Allow: GET, POST, OPTIONS`，不建立付款 middleware，也不呼叫 facilitator 或 core。Hono 會把 HEAD 分派給 GET handler，但保留原始請求方法，因此必須在進入 x402 SDK 前明確阻擋，避免 HEAD 未命中付款規則卻觸發查核。

`x402.org` 公開 facilitator 的 EVM exact scheme 目前只支援 Base Sepolia。正式設定使用 Coinbase
CDP；`generateJwt()` 會用 CDP Key ID／Secret 為 `supported`、`verify`、`settle`
分別產生綁定 method、host、path 的短效 JWT。CDP keys 不可缺一，也不可和固定
`FACILITATOR_AUTH_TOKEN` 混用。generic facilitator 則使用標準 `HTTPFacilitatorClient`，並實際讀取
`/supported`，不可再以設定值假裝 facilitator 支援某個網路。

付費端點 CORS 固定回 `Access-Control-Allow-Origin: *`，預檢允許 `Content-Type`、`PAYMENT-SIGNATURE`、`X-PAYMENT`，並 expose `PAYMENT-REQUIRED`、`PAYMENT-RESPONSE`、`X-Request-Id`、`Cache-Control`。不設 cookie 或 JWT 通行證。

## core proxy

`POST /api/fact-check` 只轉送 `{ text, url? }` JSON；`GET /api/fact-check?text=...&url=...` 會先解析並驗證 query，再建立新的 POST JSON request 給 core。呼叫端的 HTTP 方法不會原樣傳給 core，core 一律收到 `POST /fact-check`。proxy 以 `new Response(upstream.body, upstream)` 保留上游狀態、本文串流與標頭，建立可變的 headers，供 x402 SDK 與 CORS 安全調整；不預先讀取、緩衝或 tee 本文。這可避免 SDK 修改 service binding 的不可變 headers 時，把 core 的 `502` 錯誤意外轉成 `500` 並覆蓋本文。

service binding 未設定或 `fetch()` 拋出例外時回 `502 UPSTREAM_UNAVAILABLE`；由於這是 handler 錯誤，付款不會結算，客戶端不被扣款。core 回 `2xx` 但內容為業務錯誤時仍可能結算；此外 settle 本身的網路失敗需要另外確認付款狀態。x402 沒有內建退款。

## 免費 demo 守護

`/api/demo` 維持：

- POST `Origin` guard：同源或正式來源／本機來源清單才允許。
- 既有來源回填 CORS 與預檢處理。
- `RATE_LIMITER` + `RATE_LIMIT_DO` 的 IP 流量限制；精準冷卻預設每個 IP 每 60 秒一次。
- POST body 原樣轉成 core `/fact-check` request。

`RATE_LIMITER` 仍是每 10 秒 30 次的洪水層；`RATE_LIMIT_WINDOW_MS` 可覆寫 60 秒的
`RATE_LIMIT_DO` 冷卻時間。`RateLimiterDO` 在儲存交易中讀取、判斷並持久化 `lastAllowedMs`，
物件閒置回收或重新啟動不會提前結束冷卻；同一 IP 的並發請求只放行一次，被拒絕的請求不延長冷卻。
未綁定或限流服務發生錯誤時，仍沿用該層放行的既有政策。
這些守護只屬於免費 demo；付費查核完全由 x402 負責付款，
不能把 demo 的 Origin 或 IP 限制套回付費路由。

## 輸入限制與錯誤

- `text` 必填；先移除首尾空白，再按 Unicode code point 計算，最多 10,000 個。非 BMP 字元也只算一個 code point，不以 UTF-16 code unit 長度誤拒；JSON 本文仍獨立受 byte 上限限制。
- `url` 選填，限公開 HTTP／HTTPS 網址，最多 2,048 個字元，不可含帳號密碼或內網位址。
- POST `Content-Type` 必須為 `application/json`，本文最多 128,000 bytes。即使未提供 `Content-Length`，仍逐塊累計 bytes，超限立即取消串流並回 `413 PAYLOAD_TOO_LARGE`；總讀取時間上限為 10 秒，逾時取消串流並回 `400 INVALID_INPUT`。來源取消未完成不會延遲錯誤回應，這些輸入錯誤不呼叫 core，也不 settle。
- 設定、錯誤訊息與對使用者可見字串使用繁體中文；固定 error code 與 API 欄位維持英文契約。

`wrangler.jsonc` 的 `migrations` `v1`、`v2` 是既有歷史，不能刪改；追加的 `v3` 以 `deleted_classes: ["UsageBudget"]` 退役已移除的 class，保留 `RateLimiterDO`。本次只修改本機設定，尚未套用或驗證遠端 migration；之後部署會永久刪除 `UsageBudget` namespace、其中所有 Durable Object 與儲存資料。部署前必須先備份需要保留的資料、確認無依賴並取得明確核准，詳見 [`deploy_notes.md`](../../deploy_notes.md#durable-object-遷移警示usagebudget)。本機 metadata 檢查或 dry run 不能證明遠端 migration 已成功。
